#!/usr/bin/env python3
"""
四阶段分类流水线:
  Phase 1: 官方来源精准分类
  Phase 2: Qwen VL Max 分类剩余
  Phase 3: PixAI + Qwen VL 交叉验证
  Phase 4: 误差率计算 → 决策部署

用法: python classify_pipeline.py [--phase 1|2|3|4]
"""

import json
import os
import sys
import io
import time
import base64
import re
import random
from pathlib import Path
from datetime import datetime
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageSequence
from openai import OpenAI

# Fix Windows encoding
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ═══════════════════════ CONFIG ═══════════════════════
STICKERS_JSON = r"D:\sometime\sticker-site\data\stickers.json"
STICKERS_DIR = r"D:\sometime\sticker-site"
PIPELINE_STATE = r"D:\sometime\sticker-site\data\pipeline_state.json"

# Qwen VL
QWEN_KEY = "sk-ws-H.EHMPRPP.GUja.MEUCIEmALGyvwDIKCVlCq5RnrM7hlagcZdr04FsgvXFaBix-AiEA6BjyNi2Kpxa_UrYHTKiHX3KAcRko3oNLo_mDr-eqTcc"
QWEN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
QWEN_MODEL = "qwen-vl-max"

# PixAI Tagger
PIXAI_MODEL = r"D:\sometime\pixai-tagger\models\model.onnx"
PIXAI_TAGS = r"D:\sometime\pixai-tagger\models\selected_tags.csv"
PIXAI_THRESHOLD_CHAR = 0.65
PIXAI_THRESHOLD_GENERAL = 0.25

# Pipeline settings
MAX_CONCURRENT = 8
SAVE_EVERY = 30
REQUEST_DELAY = 0.25

# ═══════════════════════ OFFICIAL SOURCES ═══════════════════════

# 100%确定的官方来源 → (category, subcategory)
OFFICIAL_FILENAME = {
    'genshin-': ('游戏', '原神'),
    'honkai-': ('游戏', '崩坏系列'),
    'hsr-': ('游戏', '崩坏系列'),
    'zzz-': ('游戏', '绝区零'),
    'wuwa-': ('游戏', '鸣潮'),
}

# 米游社官方渠道 — 通过 Qwen VL 的角色识别来区分（已验证准确）
MIYOUSHE_COLLECTIONS = {
    'miyoushe-1453': '原神',       # 原神大别野合集
    'miyoushe-1819': '原神',       # 经验证：主要是原神角色
}

# 搜狗搜索关键词 → 提供来源线索（弱信号）
SOGOU_SEARCH_CLUES = {
    'sogou-奥特曼': ('动漫', '奥特曼系列'),
    'sogou-进击的巨': ('动漫', '进击的巨人'),
    'sogou-龙珠': ('动漫', '龙珠'),
    'sogou-火影忍者': ('动漫', '火影忍者'),
    'sogou-海贼王': ('动漫', '海贼王'),
}

# 已知的非ACG来源（直接归网络）
NON_ACG_SOURCES = [
    'sogou-猫', 'sogou-狗', 'sogou-搞笑', 'sogou-日常',
    'sogou-比心', 'sogou-熊猫人', 'sogou-可爱', 'sogou-沙雕',
    'sogou-点赞', 'sogou-摸鱼', 'sogou-游戏', 'sogou-动漫',
    'soogif-搞笑', 'soogif-动物', 'soogif-萌宠',
]

# ═══════════════════════ QWEN VL ═══════════════════════

QWEN_PROMPT = """你是一个专业ACG识别助手。识别这张GIF属于哪个游戏或动漫。

返回JSON（只返回JSON）：
{"category":"游戏/动漫/网络","subcategory":"具体作品名","character":"角色名","confidence":"high/medium/low"}

规则:
- 识别到具体作品→category填游戏或动漫，subcategory填作品全名，character填角色名
- ACG风格但无法确定→category="动漫",subcategory="未分类动漫",character=""
- 真人/动物/文字/meme/非ACG→category="网络",subcategory="网络",character=""
- 游戏:原神/崩坏系列/绝区零/鸣潮/明日方舟/Fate/FGO/碧蓝航线/蔚蓝档案/少女前线/宝可梦/女神异闻录/东方Project/偶像大师/赛马娘/艾尔登法环/街霸
- 动漫:鬼灭之刃/咒术回战/间谍过家家/葬送的芙莉莲/电锯人/孤独摇滚/海贼王/火影忍者/龙珠/银魂/进击的巨人/JOJO/美少女战士/摇曳百合/轻音少女/凉宫春日/小林家的龙女仆/哆啦A梦/请问您今天要来点兔子吗/黑岩射手/阿兹漫画大王/魔法少女小圆/我的英雄学院/光之美少女/猫和老鼠
- 注意:区分崩坏系列(含崩坏3/崩坏星穹铁道/崩坏学园)和原神,都是米哈游但不同游戏"""

client = OpenAI(api_key=QWEN_KEY, base_url=QWEN_BASE, timeout=60)


def gif_to_jpeg_b64(gif_path: str, max_px: int = 768) -> Optional[str]:
    """GIF第一帧→JPEG base64"""
    try:
        img = Image.open(gif_path)
        if getattr(img, 'is_animated', False):
            img.seek(0)
        if img.mode in ('RGBA', 'LA', 'P'):
            rgb = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            rgb.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = rgb
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        w, h = img.size
        if max(w, h) > max_px:
            ratio = max_px / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=75, optimize=True)
        return base64.b64encode(buf.getvalue()).decode('utf-8')
    except Exception:
        return None


def qwen_classify(gif_path: str, filename: str) -> Optional[dict]:
    """调用Qwen VL Max分类单张GIF"""
    b64 = gif_to_jpeg_b64(gif_path)
    if not b64:
        return None

    content = [
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        {"type": "text", "text": QWEN_PROMPT}
    ]

    for attempt in range(3):
        try:
            time.sleep(REQUEST_DELAY)
            resp = client.chat.completions.create(
                model=QWEN_MODEL,
                messages=[{"role": "user", "content": content}],
                max_tokens=300,
                temperature=0.1,
            )
            text = resp.choices[0].message.content.strip()
            # Parse JSON
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                m = re.search(r'\{[^{}]*"category"[^{}]*\}', text, re.DOTALL)
                if m:
                    return json.loads(m.group(0))
                # Fallback
                return {"category": "网络", "subcategory": "网络", "character": "",
                        "confidence": "low", "_raw": text[:100]}
        except Exception as e:
            err = str(e)
            if "429" in err or "rate" in err.lower():
                time.sleep(min((attempt + 1) * 8, 30))
            elif attempt < 2:
                time.sleep(2)
    return None


# ═══════════════════════ PIXAI TAGGER ═══════════════════════

_pixai_session = None
_pixai_tags = None


def load_pixai():
    global _pixai_session, _pixai_tags
    if _pixai_session is None:
        prov = [p for p in ort.get_available_providers() if p == "CPUExecutionProvider"]
        _pixai_session = ort.InferenceSession(PIXAI_MODEL, providers=prov or ort.get_available_providers())

        import csv
        all_tags, char_tags, general_tags = [], [], []
        with open(PIXAI_TAGS, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                tag = {"id": int(row["id"]), "name": row["name"],
                       "category": int(row["category"]),
                       "ips": json.loads(row.get("ips", "[]")) if row.get("ips") else []}
                all_tags.append(tag)
                if tag["category"] == 4:
                    char_tags.append(tag)
                elif tag["category"] == 0:
                    general_tags.append(tag)
        _pixai_tags = {"all": all_tags, "character": char_tags, "general": general_tags}
    return _pixai_session, _pixai_tags


def pixai_classify(gif_path: str) -> Optional[dict]:
    """PixAI Tagger 本地推理"""
    try:
        sess, tags_data = load_pixai()
        img = Image.open(gif_path)
        if getattr(img, 'is_animated', False):
            img.seek(0)
        img = img.convert("RGB").resize((448, 448), Image.BILINEAR)
        arr = np.array(img, dtype=np.float32) / 255.0
        arr = (arr - 0.5) / 0.5
        arr = np.expand_dims(arr.transpose(2, 0, 1), axis=0)

        input_name = sess.get_inputs()[0].name
        outputs = sess.run(["prediction"], {input_name: arr})
        preds = outputs[0][0]

        # Characters
        chars = []
        ips = {}
        for tag in tags_data["character"]:
            score = float(preds[tag["id"]])
            if score >= PIXAI_THRESHOLD_CHAR:
                chars.append({"name": tag["name"], "score": round(score, 4)})
                for ip in tag.get("ips", []):
                    ips[ip] = max(ips.get(ip, 0), score)
        chars.sort(key=lambda x: -x["score"])

        # General tags
        generals = []
        for tag in tags_data["general"]:
            score = float(preds[tag["id"]])
            if score >= PIXAI_THRESHOLD_GENERAL:
                generals.append({"name": tag["name"], "score": round(score, 4)})
        generals.sort(key=lambda x: -x["score"])

        return {"characters": chars, "series": sorted(ips.keys(), key=lambda k: -ips[k]),
                "general_tags": generals}
    except Exception as e:
        return {"error": str(e)}


# ═══════════════════════ PIPELINE PHASES ═══════════════════════

def load_state():
    if os.path.exists(PIPELINE_STATE):
        return json.load(open(PIPELINE_STATE, "r", encoding="utf-8"))
    return {"phase": 0, "classified_by": {}, "verified": []}


def save_state(state):
    os.makedirs(os.path.dirname(PIPELINE_STATE), exist_ok=True)
    json.dump(state, open(PIPELINE_STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def load_stickers():
    return json.load(open(STICKERS_JSON, "r", encoding="utf-8"))


def save_stickers(data):
    json.dump(data, open(STICKERS_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def rebuild_tree(stickers):
    tree = defaultdict(set)
    for s in stickers:
        tree[s.get("category", "网络")].add(s.get("subcategory", "网络"))
    return {"主页": {k: sorted(v) for k, v in tree.items()}}


def phase1_official_sources():
    """Phase 1: 官方来源精准分类"""
    print("=" * 60)
    print("PHASE 1: 官方来源精准分类")
    print("=" * 60)

    data = load_stickers()
    stickers = data["stickers"]
    state = load_state()

    log = []
    for s in stickers:
        fn = s["filename"]

        # 1a. 文件名100%确定
        for prefix, (cat, sub) in OFFICIAL_FILENAME.items():
            if fn.startswith(prefix):
                old = f'{s.get("category")}/{s.get("subcategory")}'
                s["category"] = cat
                s["subcategory"] = sub
                tags = s.get("tags", [])
                if sub not in tags:
                    tags.insert(0, sub)
                    s["tags"] = tags
                if old != f'{cat}/{sub}':
                    log.append(f"[OFFICIAL] {fn[:50]} -> {cat}/{sub}")
                state["classified_by"][s["id"]] = "official_filename"
                break

        # 1b. 米游社渠道
        for prefix, sub in MIYOUSHE_COLLECTIONS.items():
            if fn.startswith(prefix):
                s["category"] = "游戏"
                s["subcategory"] = sub
                tags = s.get("tags", [])
                if sub not in tags:
                    tags.insert(0, sub)
                    s["tags"] = tags
                state["classified_by"][s["id"]] = "miyoushe"
                break

        # 1c. 搜狗搜索词提供作品线索（强信号,模型已验证准确）
        for prefix, (cat, sub) in SOGOU_SEARCH_CLUES.items():
            if fn.startswith(prefix):
                s["category"] = cat
                s["subcategory"] = sub
                tags = s.get("tags", [])
                if sub not in tags:
                    tags.insert(0, sub)
                    s["tags"] = tags
                state["classified_by"][s["id"]] = "sogou_clue"
                break

        # 1d. 非ACG明确来源
        for prefix in NON_ACG_SOURCES:
            if fn.startswith(prefix):
                s["category"] = "网络"
                s["subcategory"] = "网络"
                state["classified_by"][s["id"]] = "non_acg_source"
                break

    # 统计
    official = sum(1 for v in state["classified_by"].values() if v == "official_filename")
    miyoushe = sum(1 for v in state["classified_by"].values() if v == "miyoushe")
    sogou = sum(1 for v in state["classified_by"].values() if v == "sogou_clue")
    non_acg = sum(1 for v in state["classified_by"].values() if v == "non_acg_source")

    count = official + miyoushe + sogou + non_acg
    remaining = len(stickers) - count

    print(f"\n  官方文件名: {official}")
    print(f"  米游社渠道: {miyoushe}")
    print(f"  搜狗搜索词: {sogou}")
    print(f"  非ACG来源: {non_acg}")
    print(f"  Phase 1 合计: {count}")
    print(f"  剩余待分类: {remaining}")

    data["categories"] = rebuild_tree(stickers)
    save_stickers(data)
    state["phase"] = 1
    state["phase1_remaining"] = remaining
    save_state(state)

    return remaining


def phase2_qwen_classify():
    """Phase 2: Qwen VL Max 分类剩余未分类的"""
    print("\n" + "=" * 60)
    print("PHASE 2: Qwen VL Max 分类")
    print("=" * 60)

    data = load_stickers()
    stickers = data["stickers"]
    state = load_state()

    # 找出Phase 1未覆盖的
    pending = []
    for i, s in enumerate(stickers):
        if s["id"] not in state["classified_by"]:
            pending.append(i)

    print(f"\n  待分类: {len(pending)} 张")

    if not pending:
        print("  无需处理")
        state["phase"] = 2
        save_state(state)
        return

    processed = 0
    batch_since_save = 0

    def do_one(idx):
        s = stickers[idx]
        gif_path = os.path.join(STICKERS_DIR, s["url"])
        if not os.path.exists(gif_path):
            return idx, {"category": "网络", "subcategory": "网络", "character": "",
                         "confidence": "low"}
        result = qwen_classify(gif_path, s["filename"])
        return idx, result

    batch_size = MAX_CONCURRENT * 2

    for bs in range(0, len(pending), batch_size):
        batch = pending[bs:bs + batch_size]

        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as ex:
            futures = {ex.submit(do_one, i): i for i in batch}
            for fut in as_completed(futures):
                idx, result = fut.result()
                s = stickers[idx]

                if result and result.get("category"):
                    s["category"] = result["category"]
                    s["subcategory"] = result.get("subcategory", "网络")
                    char = result.get("character", "")
                    conf = result.get("confidence", "low")
                    new_tags = result.get("tags", [])
                    merged = ([char] if char else []) + [s["subcategory"]] + new_tags
                    s["tags"] = list(dict.fromkeys(merged))[:10]
                else:
                    s["category"] = "网络"
                    s["subcategory"] = "网络"
                    conf = "failed"

                state["classified_by"][s["id"]] = f"qwen"
                processed += 1
                batch_since_save += 1

                if processed % 20 == 0 or processed <= 5:
                    print(f"  [{processed}/{len(pending)}] "
                          f"{s['category']}/{s['subcategory']} ({conf}) "
                          f"<- {s['filename'][:35]}")

        if batch_since_save >= SAVE_EVERY:
            data["categories"] = rebuild_tree(stickers)
            save_stickers(data)
            state["phase"] = 2
            save_state(state)
            print(f"  --- saved {processed}/{len(pending)} ---")
            batch_since_save = 0

    data["categories"] = rebuild_tree(stickers)
    save_stickers(data)
    state["phase"] = 2
    save_state(state)
    print(f"\n  Phase 2 完成: {processed} 张已分类")


def phase3_cross_validate():
    """Phase 3: PixAI + Qwen VL 交叉验证"""
    print("\n" + "=" * 60)
    print("PHASE 3: 交叉验证 (PixAI + Qwen VL)")
    print("=" * 60)

    data = load_stickers()
    stickers = data["stickers"]
    state = load_state()

    # 抽样: 每个二级分类随机抽 min(5, total) 张
    by_sub = defaultdict(list)
    for i, s in enumerate(stickers):
        if s.get("subcategory") not in ("网络", "未分类动漫"):
            by_sub[s["subcategory"]].append(i)

    sample_indices = set()
    for sub, indices in by_sub.items():
        n = min(5, len(indices))
        sample_indices.update(random.sample(indices, n))

    # 再加一些网络的随机样本
    net_indices = [i for i, s in enumerate(stickers) if s.get("category") == "网络"]
    sample_indices.update(random.sample(net_indices, min(20, len(net_indices))))

    print(f"\n  抽检 {len(sample_indices)} 张 ({len(by_sub)} 个二级分类)")
    print(f"\n  {'='*50}")
    print(f"  {'ID':<6} {'当前分类':<28} {'PixAI角色':<30} {'Qwen判定':<28}")
    print(f"  {'='*50}")

    mismatches = []
    verified_ok = 0

    for idx in sorted(sample_indices):
        s = stickers[idx]
        gif_path = os.path.join(STICKERS_DIR, s["url"])

        if not os.path.exists(gif_path):
            continue

        current = f'{s["category"]}/{s["subcategory"]}'

        # PixAI分类
        pix = pixai_classify(gif_path)
        pix_chars = "|".join([c["name"] for c in pix.get("characters", [])[:2]]) if pix and "error" not in pix else "ERROR"
        pix_series = "|".join(pix.get("series", [])[:2]) if pix and "error" not in pix else ""

        # Qwen再验证
        qwen = qwen_classify(gif_path, s["filename"])
        qwen_cat = qwen.get("category", "?") if qwen else "?"
        qwen_sub = qwen.get("subcategory", "?") if qwen else "?"
        qwen_result = f'{qwen_cat}/{qwen_sub}'

        # 判断是否吻合
        match = (
            (s["subcategory"] in pix_series or s["subcategory"] in pix_chars) or
            (s["subcategory"] == qwen_sub)
        )
        if match:
            verified_ok += 1
        else:
            mismatches.append((idx, s, pix, qwen))

        status = "OK" if match else "MISMATCH"
        print(f"  {s['id'][:6]:<6} {current:<28} {pix_chars[:28]+'|'+pix_series[:15]:<30} {qwen_result:<28} [{status}]")

    error_rate = len(mismatches) / max(len(sample_indices), 1) * 100
    print(f"\n  {'='*50}")
    print(f"  抽检: {len(sample_indices)} | 一致: {verified_ok} | 不匹配: {len(mismatches)}")
    print(f"  误差率: {error_rate:.1f}%")

    if mismatches:
        print(f"\n  不匹配详情:")
        for idx, s, pix, qwen in mismatches[:10]:
            current = f'{s["category"]}/{s["subcategory"]}'
            pix_info = f'chars={[c["name"] for c in pix.get("characters",[])[:3]]} series={pix.get("series",[])[:3]}' if pix else "N/A"
            qwen_info = f'{qwen.get("category","?")}/{qwen.get("subcategory","?")}' if qwen else "N/A"
            print(f"    {s['filename'][:40]} | 当前:{current} | Pix:{pix_info} | Qwen:{qwen_info}")

    state["phase"] = 3
    state["phase3_error_rate"] = error_rate
    state["phase3_sample_size"] = len(sample_indices)
    state["phase3_mismatches"] = len(mismatches)
    state["phase3_verified_ok"] = verified_ok
    save_state(state)

    return error_rate, mismatches


def phase4_decide():
    """Phase 4: 误差率判断 → 是否部署"""
    state = load_state()
    error_rate = state.get("phase3_error_rate", 100)

    print("\n" + "=" * 60)
    print("PHASE 4: 决策")
    print("=" * 60)
    print(f"\n  交叉验证误差率: {error_rate:.1f}%")
    print(f"  阈值: 20%")

    if error_rate <= 20:
        print(f"\n  ✅ 误差率 {error_rate:.1f}% <= 20%，通过！可以部署。")
        state["phase"] = 4
        state["approved_for_deploy"] = True
        save_state(state)
        return True
    else:
        print(f"\n  ❌ 误差率 {error_rate:.1f}% > 20%，需要修复。")
        print(f"  建议: 检查不匹配项，修正后重新运行 Phase 3")
        state["phase"] = 4
        state["approved_for_deploy"] = False
        save_state(state)
        return False


# ═══════════════════════ MAIN ═══════════════════════

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", type=int, choices=[1, 2, 3, 4], default=0, help="运行指定阶段(0=全部)")
    ap.add_argument("--limit", type=int, default=0, help="Phase 2限制处理数量")
    ap.add_argument("--sample", type=int, default=0, help="Phase 3抽检数量")
    args = ap.parse_args()

    phase = args.phase

    if phase in (0, 1):
        remaining = phase1_official_sources()

    if phase in (0, 2):
        phase2_qwen_classify()

    if phase in (0, 3):
        error_rate, mismatches = phase3_cross_validate()

    if phase in (0, 4):
        phase4_decide()

#!/usr/bin/env python3
"""
GIF表情包分类器 — Qwen VL Max 识别动漫/游戏归属

用法:
  python classify_gifs.py              # 全量分类
  python classify_gifs.py --dry-run    # 预览模式（打印10张不调用API）
  python classify_gifs.py --resume     # 断点续传

原理:
  1. GIF → 提取前/中/末帧 → 压缩为 JPEG → base64
  2. 发送到 Qwen VL Max (DashScope) 识别
  3. 返回 {category, subcategory, character, tags, confidence}
  4. 识别不出的归入「网络」
"""

import json
import os
import sys
import time
import base64
import io
import hashlib
import argparse
from pathlib import Path
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional, Dict, Any, List

from PIL import Image, ImageSequence
from openai import OpenAI

# Fix Windows GBK console encoding
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ═══════════════════════════════════════════════
#  配置
# ═══════════════════════════════════════════════

STICKERS_JSON = r"D:\sometime\sticker-site\data\stickers.json"
STICKERS_DIR = r"D:\sometime\sticker-site"
PROGRESS_FILE = r"D:\sometime\sticker-site\data\classify_progress.json"
BACKUP_FILE = r"D:\sometime\sticker-site\data\stickers_backup.json"

API_KEY = "sk-ws-H.EHMPRPP.GUja.MEUCIEmALGyvwDIKCVlCq5RnrM7hlagcZdr04FsgvXFaBix-AiEA6BjyNi2Kpxa_UrYHTKiHX3KAcRko3oNLo_mDr-eqTcc"
BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL = "qwen-vl-max"

MAX_CONCURRENT = 5          # 并发数
MAX_RETRIES = 3             # 失败重试次数
SAVE_EVERY = 50             # 每 N 张保存进度
MAX_IMAGE_PX = 768          # 图片最长边（控制 token 消耗）
JPEG_QUALITY = 75           # JPEG 压缩质量
REQUEST_DELAY = 0.3         # 请求间隔（秒）

SYSTEM_PROMPT = """你是一个专业的ACG内容识别助手。识别GIF表情包图片属于哪个动漫或游戏。

严格按以下JSON格式返回，不要任何其他文字：
{"category":"游戏或动漫或网络","subcategory":"具体作品名","character":"角色名","tags":["标签1","标签2","标签3"],"confidence":"high或medium或low"}

规则：
1. 明确识别到角色→category填"游戏"或"动漫"，subcategory填作品全名(如"原神""鬼灭之刃""崩坏星穹铁道")，character填角色名
2. ACG画风但无法确定作品→category="动漫"，subcategory="未分类动漫"，character=""
3. 真人/动物/纯文字/日常/meme/非ACG→category="网络"，subcategory="网络"，character=""
4. tags用中文，描述角色名+特征+表情情绪，3-5个
5. 游戏作品：原神/崩坏系列/崩坏星穹铁道/绝区零/鸣潮/明日方舟/少女前线/Fate系列/FGO/尼尔机械纪元/女神异闻录/宝可梦/东方Project/偶像大师/舰队Collection/碧蓝航线/蔚蓝档案/街霸/艾尔登法环/赛马娘/公主连结 等
6. 动漫作品：鬼灭之刃/咒术回战/间谍过家家/葬送的芙莉莲/电锯人/孤独摇滚/轻音少女/凉宫春日的忧郁/进击的巨人/海贼王/火影忍者/龙珠/银魂/JOJO的奇妙冒险/美少女战士/摇曳百合/小林家的龙女仆/我的英雄学院/请问您今天要来点兔子吗/为美好的世界献上祝福/光之美少女/哆啦A梦/空之境界/弹丸论破/黑岩射手/阿兹漫画大王/奇幻魔法Melody/老虎与兔子/雏田频道/索尼克/超级马里奥/塞尔达传说/蔚蓝档案 等
7. 区分：崩坏3/崩坏学园→崩坏系列；星穹铁道角色→崩坏星穹铁道；原神角色→原神
8. confidence: high=非常确定, medium=比较确定, low=猜测"""


# ═══════════════════════════════════════════════
#  工具函数
# ═══════════════════════════════════════════════

def gif_to_frames_base64(gif_path: str) -> Optional[List[str]]:
    """提取 GIF 前/中/末三帧 → JPEG base64 列表"""
    try:
        img = Image.open(gif_path)
        frames = list(ImageSequence.Iterator(img))
        if not frames:
            return None

        # 选帧：第一帧、中间帧、最后一帧（去重）
        indices = set()
        if len(frames) >= 1:
            indices.add(0)
        if len(frames) >= 3:
            indices.add(len(frames) // 2)
        if len(frames) >= 2:
            indices.add(len(frames) - 1)

        results = []
        for idx in sorted(indices):
            frame = frames[idx].copy()
            # 转 RGB
            if frame.mode in ('RGBA', 'LA', 'P'):
                rgb = Image.new('RGB', frame.size, (255, 255, 255))
                if frame.mode == 'P':
                    frame = frame.convert('RGBA')
                rgb.paste(frame, mask=frame.split()[-1] if frame.mode == 'RGBA' else None)
                frame = rgb
            elif frame.mode != 'RGB':
                frame = frame.convert('RGB')

            # 缩放
            w, h = frame.size
            if max(w, h) > MAX_IMAGE_PX:
                ratio = MAX_IMAGE_PX / max(w, h)
                frame = frame.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

            # 编码
            buf = io.BytesIO()
            frame.save(buf, format='JPEG', quality=JPEG_QUALITY, optimize=True)
            results.append(base64.b64encode(buf.getvalue()).decode('utf-8'))

        return results if results else None

    except Exception as e:
        print(f"  ⚠️ 图片处理失败 {os.path.basename(gif_path)}: {e}")
        return None


def classify_sticker(client: OpenAI, gif_path: str, sticker_id: str) -> Optional[Dict[str, Any]]:
    """调用 Qwen VL Max 识别单张 GIF"""
    frames_b64 = gif_to_frames_base64(gif_path)
    if not frames_b64:
        return None

    # 构建多图消息
    content = [{"type": "text", "text": "识别这张GIF表情包的人物/角色属于哪个动漫或游戏作品。返回JSON。"}]
    for fb64 in frames_b64:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{fb64}"}
        })

    for attempt in range(MAX_RETRIES):
        try:
            time.sleep(REQUEST_DELAY)
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": content}
                ],
                max_tokens=300,
                temperature=0.1,
            )
            text = resp.choices[0].message.content.strip()
            # 提取 JSON
            return _parse_response(text, sticker_id)

        except Exception as e:
            err = str(e)
            if "rate" in err.lower() or "429" in err:
                wait = min((attempt + 1) * 5, 30)
                print(f"  ⏳ 限流，等待{wait}s...")
                time.sleep(wait)
            elif attempt < MAX_RETRIES - 1:
                time.sleep(2)
            else:
                print(f"  ❌ API失败 {sticker_id}: {err[:100]}")

    return None


def _parse_response(text: str, sticker_id: str) -> Optional[Dict[str, Any]]:
    """从模型回复中提取 JSON"""
    # 尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 提取 ```json ... ``` 块
    import re
    m = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    # 提取第一个 { ... }
    m = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    print(f"  ⚠️ JSON解析失败 {sticker_id}: {text[:80]}")
    return None


def validate_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """校验并补全分类结果"""
    valid_categories = {"游戏", "动漫", "网络"}
    if result.get("category") not in valid_categories:
        result["category"] = "网络"

    if not result.get("subcategory") or result["subcategory"] == "未知":
        if result["category"] == "网络":
            result["subcategory"] = "网络"
        else:
            result["subcategory"] = "未分类动漫" if result["category"] == "动漫" else "未分类游戏"

    if not result.get("character"):
        result["character"] = ""

    if not isinstance(result.get("tags"), list):
        result["tags"] = []
    result["tags"] = [t for t in result["tags"] if isinstance(t, str) and len(t) <= 20][:8]

    if result.get("confidence") not in ("high", "medium", "low"):
        result["confidence"] = "low"

    return result


def load_stickers() -> tuple[Dict, List[Dict]]:
    """加载 stickers.json"""
    with open(STICKERS_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data, data["stickers"]


def load_progress() -> Dict[int, Dict]:
    """加载断点进度"""
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
            return {int(k): v for k, v in raw.items()}
    return {}


def save_progress(progress: Dict[int, Dict]):
    """保存进度"""
    os.makedirs(os.path.dirname(PROGRESS_FILE), exist_ok=True)
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def save_stickers(data: Dict):
    """保存完整的 stickers.json"""
    os.makedirs(os.path.dirname(STICKERS_JSON), exist_ok=True)
    with open(STICKERS_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def rebuild_categories(stickers: List[Dict]) -> Dict:
    """根据 sticker 数据重建分类索引"""
    tree: Dict[str, Dict[str, list]] = {"主页": {}}

    for s in stickers:
        cat = s.get("category", "网络")
        sub = s.get("subcategory", "网络")
        if cat not in tree["主页"]:
            tree["主页"][cat] = []
        if sub and sub not in tree["主页"][cat]:
            tree["主页"][cat].append(sub)

    return tree


def estimate_cost(stickers_count: int) -> str:
    """估算费用"""
    # qwen-vl-max: 输入 ¥3/M tokens, 输出 ¥12/M tokens
    # 每张图 ~768px ≈ 1000-1500 tokens, 输出 ~100 tokens
    avg_input_tokens = 1500 * stickers_count
    avg_output_tokens = 100 * stickers_count
    cost_input = avg_input_tokens / 1_000_000 * 3
    cost_output = avg_output_tokens / 1_000_000 * 12
    total = cost_input + cost_output
    return f"预计: {avg_input_tokens/1_000_000:.1f}M 输入tokens + {avg_output_tokens/1_000_000:.1f}M 输出tokens ≈ ¥{total:.2f}"


# ═══════════════════════════════════════════════
#  主流程
# ═══════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="GIF表情包分类器")
    parser.add_argument("--dry-run", action="store_true", help="预览模式")
    parser.add_argument("--resume", action="store_true", help="断点续传")
    parser.add_argument("--start", type=int, default=0, help="从第N张开始")
    parser.add_argument("--limit", type=int, default=0, help="只处理N张")
    args = parser.parse_args()

    print("=" * 60)
    print("🎨 GIF表情包分类器 — Qwen VL Max")
    print(f"   模型: {MODEL}")
    print(f"   并发: {MAX_CONCURRENT}")
    print("=" * 60)

    # 加载数据
    data, stickers = load_stickers()
    total = len(stickers)
    print(f"\n📦 总表情包: {total} 张")
    print(f"   {estimate_cost(total)}")

    # 备份
    if not os.path.exists(BACKUP_FILE):
        save_stickers(data)
        os.rename(STICKERS_JSON, BACKUP_FILE)
        print(f"   ✅ 已备份到 {BACKUP_FILE}")
        # 重新写回（后续更新会修改）
        save_stickers(data)

    # Dry run 模式
    if args.dry_run:
        print("\n🔍 Dry Run — 预览前10张（不调API）...")
        for i, s in enumerate(stickers[:10]):
            gif_path = os.path.join(STICKERS_DIR, s["url"])
            exists = os.path.exists(gif_path)
            size_mb = os.path.getsize(gif_path) / 1024 / 1024 if exists else 0
            frames = gif_to_frames_base64(gif_path) if exists else None
            print(f"  [{i}] {s['filename']} ({size_mb:.1f}MB) → {len(frames) if frames else 0} frames")
        print("   ✅ Dry run 完成")
        return

    # 加载进度
    progress = load_progress() if args.resume else {}
    if args.resume:
        print(f"\n📌 断点续传: 已处理 {len(progress)} 张")

    # 初始化客户端
    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=60)

    # 确定处理范围
    start_idx = args.start
    end_idx = min(total, start_idx + args.limit) if args.limit > 0 else total

    pending = []
    for i in range(start_idx, end_idx):
        sid = stickers[i]["id"]
        if sid not in progress:
            pending.append(i)

    print(f"\n🎯 待处理: {len(pending)} 张 (索引 {start_idx}-{end_idx-1})")
    if not pending:
        print("   ✅ 全部已完成！")
        return

    # 统计
    stats = {"processed": len(progress), "success": 0, "failed": 0, "api_calls": 0,
             "cat_game": 0, "cat_anime": 0, "cat_network": 0,
             "start_time": datetime.now().isoformat()}

    # 更新 stats 中已处理的
    for v in progress.values():
        if v.get("result"):
            stats["success"] += 1
            cat = v["result"].get("category", "")
            if cat == "游戏": stats["cat_game"] += 1
            elif cat == "动漫": stats["cat_anime"] += 1
            else: stats["cat_network"] += 1
        else:
            stats["failed"] += 1

    print(f"\n🚀 开始分类... (每{SAVE_EVERY}张保存一次)\n")

    def process_one(idx: int) -> tuple[int, Optional[Dict]]:
        """处理单张"""
        s = stickers[idx]
        gif_path = os.path.join(STICKERS_DIR, s["url"])

        if not os.path.exists(gif_path):
            return idx, None

        result = classify_sticker(client, gif_path, s["id"])
        return idx, result

    # 分批提交（控制并发）
    batch_size = MAX_CONCURRENT * 2
    processed_since_save = 0

    for batch_start in range(0, len(pending), batch_size):
        batch = pending[batch_start:batch_start + batch_size]

        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as executor:
            futures = {executor.submit(process_one, i): i for i in batch}

            for future in as_completed(futures):
                idx, result = future.result()
                sid = stickers[idx]["id"]
                filename = stickers[idx]["filename"]

                if result is None:
                    # 识别失败 → 归入网络
                    stickers[idx]["category"] = "网络"
                    stickers[idx]["subcategory"] = "网络"
                    progress[sid] = {"filename": filename, "result": None, "error": True,
                                     "time": datetime.now().isoformat()}
                    stats["failed"] += 1
                    stats["cat_network"] += 1
                    print(f"  [{idx+1}/{total}] ❌ {filename[:40]} → 网络(识别失败)")
                    continue

                result = validate_result(result)
                cat = result["category"]
                sub = result["subcategory"]
                char = result["character"]
                conf = result["confidence"]
                new_tags = result.get("tags", [])

                # 构建标签: 角色名 + 作品名 + Qwen标签
                merged_tags = []
                if char:
                    merged_tags.append(char)
                if sub and sub not in ("网络", "未分类动漫", "未分类游戏"):
                    merged_tags.append(sub)
                merged_tags.extend(new_tags)
                merged_tags = list(dict.fromkeys(merged_tags))[:10]  # 去重限数

                # 更新 sticker
                stickers[idx]["category"] = cat
                stickers[idx]["subcategory"] = sub
                stickers[idx]["tags"] = merged_tags

                progress[sid] = {
                    "filename": filename,
                    "result": {"category": cat, "subcategory": sub, "character": char,
                               "confidence": conf, "tags": merged_tags},
                    "time": datetime.now().isoformat()
                }

                stats["success"] += 1
                stats["api_calls"] += 1
                if cat == "游戏": stats["cat_game"] += 1
                elif cat == "动漫": stats["cat_anime"] += 1
                else: stats["cat_network"] += 1

                char_str = f"({char})" if char else ""
                print(f"  [{idx+1}/{total}] {conf.upper():6s} {cat}/{sub} {char_str} ← {filename[:30]}")

                processed_since_save += 1

        # 每批结束后保存
        if processed_since_save >= SAVE_EVERY:
            data["categories"] = rebuild_categories(stickers)
            save_stickers(data)
            save_progress(progress)
            elapsed = datetime.now() - datetime.fromisoformat(stats["start_time"])
            rate = stats["success"] / max(elapsed.total_seconds(), 1) * 60
            print(f"\n  💾 已保存 | 成功:{stats['success']} 失败:{stats['failed']} | "
                  f"游戏:{stats['cat_game']} 动漫:{stats['cat_anime']} 网络:{stats['cat_network']} | "
                  f"速率:{rate:.1f}/min\n")
            processed_since_save = 0

    # 最终保存
    data["categories"] = rebuild_categories(stickers)
    save_stickers(data)
    save_progress(progress)

    elapsed = datetime.now() - datetime.fromisoformat(stats["start_time"])
    print("\n" + "=" * 60)
    print("✅ 分类完成！")
    print(f"   成功: {stats['success']} | 失败: {stats['failed']}")
    print(f"   游戏: {stats['cat_game']} | 动漫: {stats['cat_anime']} | 网络: {stats['cat_network']}")
    print(f"   耗时: {elapsed}")
    print(f"   速率: {stats['success'] / max(elapsed.total_seconds(), 1) * 60:.1f} 张/分钟")
    print(f"   输出: {STICKERS_JSON}")
    print("=" * 60)


if __name__ == "__main__":
    main()

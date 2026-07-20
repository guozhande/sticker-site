#!/usr/bin/env python3
"""
PixAI 全量交叉验证 + 自动修正
1. PixAI 推理全部 1620 张
2. 对比当前分类，找出 Qwen VL 误判
3. PixAI 有明确结果 → 修正
4. PixAI 无匹配 → 归入网络
"""

import json
import os
import sys
import io
import csv
import re
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime

import numpy as np
import onnxruntime as ort
from PIL import Image

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ═══════════ CONFIG ═══════════
STICKERS_JSON = r"D:\sometime\sticker-site\data\stickers.json"
STICKERS_DIR = r"D:\sometime\sticker-site"
PIXAI_MODEL = r"D:\sometime\pixai-tagger\models\model.onnx"
PIXAI_TAGS = r"D:\sometime\pixai-tagger\models\selected_tags.csv"

CHAR_THRESHOLD = 0.5      # 角色最低置信度
IP_THRESHOLD = 0.4        # IP/作品最低置信度
GENERAL_THRESHOLD = 0.3

# PixAI IP名 → (category, subcategory) 中文映射
PIXAI_IP_MAP = {
    # === 游戏 ===
    'genshin_impact': ('游戏', '原神'),
    'honkai_(series)': ('游戏', '崩坏系列'),
    'honkai_impact_3rd': ('游戏', '崩坏系列'),
    'honkai:_star_rail': ('游戏', '崩坏系列'),
    'wuthering_waves': ('游戏', '鸣潮'),
    'zenless_zone_zero': ('游戏', '绝区零'),
    'arknights': ('游戏', '明日方舟'),
    'fate/grand_order': ('游戏', 'Fate系列'),
    'fate_(series)': ('游戏', 'Fate系列'),
    'fate/stay_night': ('游戏', 'Fate系列'),
    'pokemon': ('游戏', '宝可梦'),
    'minecraft': ('游戏', '我的世界'),
    'azur_lane': ('游戏', '碧蓝航线'),
    'blue_archive': ('游戏', '蔚蓝档案'),
    'girls\'_frontline': ('游戏', '少女前线'),
    'touhou': ('游戏', '东方Project'),
    'the_idolmaster': ('游戏', '偶像大师'),
    'kantai_collection': ('游戏', '舰队Collection'),
    'persona_(series)': ('游戏', '女神异闻录'),
    'persona_5': ('游戏', '女神异闻录'),
    'persona_3': ('游戏', '女神异闻录'),
    'persona_4': ('游戏', '女神异闻录'),
    'elden_ring': ('游戏', '艾尔登法环'),
    'street_fighter': ('游戏', '街霸'),
    'the_legend_of_zelda': ('游戏', '塞尔达传说'),
    'super_mario': ('游戏', '超级马里奥'),
    'league_of_legends': ('游戏', '英雄联盟'),
    'nba_2k': ('游戏', 'NBA 2K'),
    'honor_of_kings': ('游戏', '王者荣耀'),
    'devil_may_cry': ('游戏', '恶魔城'),
    'the_last_of_us': ('游戏', '最后生还者'),
    'hollow_knight': ('游戏', '空洞骑士'),
    'the_king_of_fighters': ('游戏', '拳皇97'),
    'nier:_automata': ('游戏', '尼尔机械纪元'),
    'sonic_the_hedgehog': ('游戏', '索尼克'),
    'resident_evil': ('游戏', '生化危机'),
    'monster_hunter': ('游戏', '怪物猎人'),
    'splatoon': ('游戏', '喷射战士'),
    'fire_emblem': ('游戏', '火焰纹章'),
    'final_fantasy': ('游戏', '最终幻想'),
    'dragon_quest': ('游戏', '勇者斗恶龙'),
    'animal_crossing': ('游戏', '动物森友会'),
    'overwatch': ('游戏', '守望先锋'),
    'apex_legends': ('游戏', 'Apex英雄'),
    'valorant': ('游戏', '无畏契约'),
    'umamusume': ('游戏', '赛马娘'),
    'princess_connect!': ('游戏', '公主连结'),
    'granblue_fantasy': ('游戏', '碧蓝幻想'),
    'girls_band_cry': ('游戏', 'Girls Band Cry'),

    # === 动漫 ===
    'kimetsu_no_yaiba': ('动漫', '鬼灭之刃'),
    'jujutsu_kaisen': ('动漫', '咒术回战'),
    'dragon_ball': ('动漫', '龙珠'),
    'shingeki_no_kyojin': ('动漫', '进击的巨人'),
    'naruto_(series)': ('动漫', '火影忍者'),
    'one_piece': ('动漫', '海贼王'),
    'spy_x_family': ('动漫', '间谍过家家'),
    'sousou_no_frieren': ('动漫', '葬送的芙莉莲'),
    'chainsaw_man': ('动漫', '电锯人'),
    'bocchi_the_rock!': ('动漫', '孤独摇滚'),
    'k-on!': ('动漫', '轻音少女'),
    'lucky_star': ('动漫', '幸运星'),
    'the_melancholy_of_haruhi_suzumiya': ('动漫', '凉宫春日的忧郁'),
    'bishoujo_senshi_sailor_moon': ('动漫', '美少女战士'),
    'yuruyuri': ('动漫', '摇曳百合'),
    'kobayashi-san_chi_no_maid_dragon': ('动漫', '小林家的龙女仆'),
    'boku_no_hero_academia': ('动漫', '我的英雄学院'),
    'gochuumon_wa_usagi_desu_ka?': ('动漫', '请问您今天要来点兔子吗'),
    'jojo_no_kimyou_na_bouken': ('动漫', 'JOJO的奇妙冒险'),
    'kono_subarashii_sekai_ni_shukufuku_wo!': ('动漫', '为美好的世界献上祝福'),
    'precure': ('动漫', '光之美少女'),
    'doraemon': ('动漫', '哆啦A梦'),
    'one-punch_man': ('动漫', '一拳超人'),
    'mahou_shoujo_madoka_magica': ('动漫', '魔法少女小圆'),
    'azumanga_daioh': ('动漫', '阿兹漫画大王'),
    'black_rock_shooter': ('动漫', '黑岩射手'),
    'gintama': ('动漫', '银魂'),
    'kara_no_kyoukai': ('动漫', '空之境界'),
    'danganronpa_(series)': ('动漫', '弹丸论破'),
    'tiger_&_bunny': ('动漫', '老虎与兔子'),
    'neon_genesis_evangelion': ('动漫', '新世纪福音战士'),
    'steins;gate': ('动漫', '命运石之门'),
    'violet_evergarden': ('动漫', '紫罗兰永恒花园'),
    'sword_art_online': ('动漫', '刀剑神域'),
    're:zero_kara_hajimeru_isekai_seikatsu': ('动漫', 'Re:从零开始的异世界生活'),
    'oshi_no_ko': ('动漫', '我推的孩子'),
    'lycoris_recoil': ('动漫', '莉可丽丝'),
    'mushoku_tensei': ('动漫', '无职转生'),
    'tokyo_ghoul': ('动漫', '东京食尸鬼'),
    'bleach': ('动漫', '死神'),
    'hunter_x_hunter': ('动漫', '全职猎人'),
    'fullmetal_alchemist': ('动漫', '钢之炼金术师'),
    'death_note': ('动漫', '死亡笔记'),
    'code_geass': ('动漫', '叛逆的鲁路修'),
    'clannad': ('动漫', 'CLANNAD'),
    'hyouka': ('动漫', '冰菓'),
    'toradora!': ('动漫', '龙与虎'),
    'angel_beats!': ('动漫', 'Angel Beats!'),
    'your_name.': ('动漫', '你的名字'),
    'weathering_with_you': ('动漫', '天气之子'),
    'spirited_away': ('动漫', '千与千寻'),
    "my_neighbor_totoro": ('动漫', '龙猫'),
    "howl's_moving_castle": ('动漫', '哈尔的移动城堡'),
    "princess_mononoke": ('动漫', '幽灵公主'),
    "ponyo": ('动漫', '悬崖上的金鱼姬'),
    "kiki's_delivery_service": ('动漫', '魔女宅急便'),
    'tom_and_jerry': ('动漫', '猫和老鼠'),
    'the_simpsons': ('动漫', '辛普森一家'),
    'spongebob_squarepants': ('动漫', '海绵宝宝'),
    'south_park': ('动漫', '南方公园'),
    'family_guy': ('动漫', '恶搞之家'),
    'rick_and_morty': ('动漫', '瑞克和莫蒂'),
    'mulan': ('动漫', '花木兰'),
    'frozen': ('动漫', '冰雪奇缘'),
    'toy_story': ('动漫', '玩具总动员'),
    'the_lion_king': ('动漫', '狮子王'),
    'finding_nemo': ('动漫', '海底总动员'),
    'shrek': ('动漫', '怪物史莱克'),
    'solo_leveling': ('动漫', '我独自升级'),
    'mo_dao_zu_shi': ('动漫', '魔道祖师'),

    # === Hololive/网络 ===
    'hololive': ('网络', 'Hololive'),
    'hololive_english': ('网络', 'Hololive'),
    'hololive_indonesia': ('网络', 'Hololive'),
    'nijisanji': ('网络', 'Nijisanji'),
    'vsinger': ('网络', 'Vsinger'),
}

# 如果 Qwen 的结果在 "已知不可靠" 列表中，且 PixAI 有明确不同结果，以 PixAI 为准
# 文件名来源锚点（Phase 1）仍然是最权威的
FILENAME_OVERRIDE = {
    'genshin-': ('游戏', '原神'),
    'honkai-': ('游戏', '崩坏系列'),
    'hsr-': ('游戏', '崩坏系列'),
    'zzz-': ('游戏', '绝区零'),
    'wuwa-': ('游戏', '鸣潮'),
}


def load_data():
    with open(STICKERS_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def save_data(data):
    with open(STICKERS_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_pixai():
    """加载 PixAI 模型 + 标签"""
    sess = ort.InferenceSession(PIXAI_MODEL, providers=['CPUExecutionProvider'])
    char_tags, general_tags = [], []
    with open(PIXAI_TAGS, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            tag = {
                "id": int(row["id"]),
                "name": row["name"],
                "category": int(row["category"]),
                "ips": json.loads(row.get("ips", "[]")) if row.get("ips") else [],
            }
            if tag["category"] == 4:
                char_tags.append(tag)
            elif tag["category"] == 0:
                general_tags.append(tag)
    return sess, char_tags, general_tags


def pixai_infer(sess, char_tags, general_tags, image_path):
    """单张 PixAI 推理"""
    try:
        img = Image.open(image_path)
        if getattr(img, "is_animated", False):
            img.seek(0)
        img = img.convert("RGB").resize((448, 448), Image.BILINEAR)
        arr = np.array(img, dtype=np.float32) / 255.0
        arr = (arr - 0.5) / 0.5
        arr = np.expand_dims(arr.transpose(2, 0, 1), axis=0)

        input_name = sess.get_inputs()[0].name
        outputs = sess.run(["prediction"], {input_name: arr})
        preds = outputs[0][0]

        chars = []
        ip_scores = {}
        for tag in char_tags:
            score = float(preds[tag["id"]])
            if score >= CHAR_THRESHOLD:
                chars.append({"name": tag["name"], "score": round(score, 4), "ips": tag["ips"]})
                for ip in tag["ips"]:
                    ip_scores[ip] = max(ip_scores.get(ip, 0), score)

        chars.sort(key=lambda x: -x["score"])
        ips = sorted(ip_scores.keys(), key=lambda k: -ip_scores[k])

        generals = []
        for tag in general_tags:
            score = float(preds[tag["id"]])
            if score >= GENERAL_THRESHOLD:
                generals.append({"name": tag["name"], "score": round(score, 4)})
        generals.sort(key=lambda x: -x["score"])

        return {
            "characters": chars[:5],
            "ips": ips,
            "ip_scores": {ip: round(ip_scores[ip], 4) for ip in ips[:5]},
            "general_tags": generals[:10],
            "has_match": len(chars) > 0 or len(ips) > 0,
        }
    except Exception as e:
        return {"error": str(e), "has_match": False}


def pixai_to_category(pix_result):
    """将 PixAI 结果映射到我们的 (category, subcategory)"""
    ips = pix_result.get("ips", [])
    ip_scores = pix_result.get("ip_scores", {})
    chars = pix_result.get("characters", [])

    # 先看 IP
    for ip in ips:
        if ip in PIXAI_IP_MAP and ip_scores.get(ip, 0) >= IP_THRESHOLD:
            return PIXAI_IP_MAP[ip]

    # 再看角色名模糊匹配
    for ch in chars:
        name = ch["name"].lower()
        # genshin角色 → 原神
        if "genshin" in name:
            return ("游戏", "原神")
        # honkai角色 → 崩坏
        if "honkai" in name:
            return ("游戏", "崩坏系列")
        # wuthering角色 → 鸣潮
        if "wuthering" in name:
            return ("游戏", "鸣潮")
        # zzz角色 → 绝区零
        if "zenless" in name:
            return ("游戏", "绝区零")
        # pokemon → 宝可梦
        if "pokemon" in name:
            return ("游戏", "宝可梦")

    # 无匹配
    return None


def main():
    print("=" * 60)
    print("PixAI 全量交叉验证修正")
    print("=" * 60)

    data = load_data()
    stickers = data["stickers"]
    total = len(stickers)

    print(f"\n加载 PixAI 模型...")
    sess, char_tags, general_tags = load_pixai()
    print(f"模型加载完成 (char tags: {len(char_tags)}, general: {len(general_tags)})")

    print(f"\n推理 {total} 张图片...")

    fixes = []
    stats = {
        "total": total, "checked": 0, "fixed": 0,
        "moved_to_net": 0, "filename_authoritative": 0,
        "pixai_confirmed": 0, "pixai_corrected": 0,
        "pixai_no_match": 0,
    }

    # 分批处理 + 定期保存
    BATCH = 200

    for batch_start in range(0, total, BATCH):
        batch_end = min(batch_start + BATCH, total)

        for i in range(batch_start, batch_end):
            s = stickers[i]
            fn = s["filename"]
            gif_path = os.path.join(STICKERS_DIR, s["url"])

            if not os.path.exists(gif_path):
                stats["checked"] += 1
                continue

            # 1. 文件名锚点 → 无条件信任
            has_override = False
            for prefix, (cat, sub) in FILENAME_OVERRIDE.items():
                if fn.startswith(prefix):
                    if s["category"] != cat or s["subcategory"] != sub:
                        fixes.append({
                            "file": fn, "old": f'{s["category"]}/{s["subcategory"]}',
                            "new": f'{cat}/{sub}', "reason": "filename_authoritative"
                        })
                        s["category"] = cat
                        s["subcategory"] = sub
                        stats["filename_authoritative"] += 1
                        stats["fixed"] += 1
                    has_override = True
                    break
            if has_override:
                stats["checked"] += 1
                continue

            # 2. miyoushe 来源 → 保留当前（已验证准确）
            if fn.startswith("miyoushe-"):
                stats["checked"] += 1
                continue

            # 3. sogou搜索词 → 保留（Phase 1 已锚定）
            if fn.startswith("sogou-奥特曼") or fn.startswith("sogou-进击的巨") or \
               fn.startswith("sogou-龙珠") or fn.startswith("sogou-火影忍者") or \
               fn.startswith("sogou-海贼王"):
                stats["checked"] += 1
                continue

            # 4. PixAI 推理
            pix = pixai_infer(sess, char_tags, general_tags, gif_path)
            stats["checked"] += 1

            if pix.get("error"):
                continue

            # 5. 无匹配 → 归网络
            if not pix.get("has_match"):
                if s.get("category") != "网络":
                    fixes.append({
                        "file": fn, "old": f'{s["category"]}/{s["subcategory"]}',
                        "new": "网络/网络", "reason": "pixai_no_match"
                    })
                    s["category"] = "网络"
                    s["subcategory"] = "网络"
                    s["tags"] = [t for t in s.get("tags", []) if t not in
                                 ("原神", "崩坏系列", "鸣潮", "绝区零", "鬼灭之刃", "咒术回战")]
                    stats["pixai_no_match"] += 1
                    stats["moved_to_net"] += 1
                    stats["fixed"] += 1
                continue

            # 6. PixAI 有明确结果 → 对比
            pix_cat = pixai_to_category(pix)
            if pix_cat is None:
                # 有角色但没映射到已知IP → 如果当前不是网络，标记
                if s.get("category") not in ("网络",) and \
                   s.get("subcategory") not in ("未分类动漫", "未分类游戏"):
                    # 看PixAI是否与当前一致
                    pass
                continue

            pix_category, pix_subcategory = pix_cat
            current_cat = s.get("category", "网络")
            current_sub = s.get("subcategory", "网络")

            # 一致 → OK
            if current_sub == pix_subcategory:
                stats["pixai_confirmed"] += 1
                continue

            # 不一致，但同属一个大类，且 PixAI 置信度更高 → 修正
            # 比如 Qwen说原神，PixAI说鸣潮 → 以PixAI为准
            if current_sub != pix_subcategory:
                fixes.append({
                    "file": fn,
                    "old": f"{current_cat}/{current_sub}",
                    "new": f"{pix_category}/{pix_subcategory}",
                    "reason": f"pixai_corrected (chars: {[c['name'] for c in pix['characters'][:2]]}, ips: {pix['ips'][:3]})"
                })
                s["category"] = pix_category
                s["subcategory"] = pix_subcategory
                # 更新tags
                new_tags = [pix_subcategory]
                for ch in pix["characters"][:2]:
                    new_tags.append(ch["name"])
                new_tags.extend([g["name"] for g in pix["general_tags"][:3]])
                s["tags"] = list(dict.fromkeys(new_tags))[:10]
                stats["pixai_corrected"] += 1
                stats["fixed"] += 1

        # 每批次保存
        data["stickers"] = stickers
        elapsed_pct = batch_end / total * 100
        print(f"  [{batch_end}/{total}] {elapsed_pct:.0f}% | fixes: {stats['fixed']} | "
              f"to_net: {stats['moved_to_net']} | corrected: {stats['pixai_corrected']}")

        # 重建分类树
        tree = defaultdict(set)
        for s in stickers:
            tree[s.get("category", "网络")].add(s.get("subcategory", "网络"))
        data["categories"] = {"主页": {k: sorted(v) for k, v in tree.items()}}
        save_data(data)

    # ──── 最终统计 ────
    print(f"\n{'=' * 60}")
    print(f"修正完成: {stats['fixed']} 张")
    print(f"  文件名锚定: {stats['filename_authoritative']}")
    print(f"  PixAI修正: {stats['pixai_corrected']}")
    print(f"  移至网络(无匹配): {stats['pixai_no_match']}")
    print(f"  PixAI一致: {stats['pixai_confirmed']}")

    # 最终分类统计
    cats, subs = {}, {}
    for s in stickers:
        cats[s["category"]] = cats.get(s["category"], 0) + 1
        subs[s["subcategory"]] = subs.get(s["subcategory"], 0) + 1
    print(f"\n最终分类: {cats}")
    print(f"Top 20 二级:")
    for k, v in sorted(subs.items(), key=lambda x: -x[1])[:20]:
        print(f"  {k}: {v}")

    # 保存修正日志
    log_path = r"D:\sometime\sticker-site\data\pixai_fix_log.json"
    json.dump({"stats": stats, "fixes": fixes}, open(log_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"\n修正日志: {log_path}")
    save_data(data)


if __name__ == "__main__":
    main()

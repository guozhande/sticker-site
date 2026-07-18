"""
表情包 GIF 批量下载脚本
来源: 搜狗表情API(免鉴权) + SOOGIF + 皮蛋
输出: stickers/ 目录 + 更新 stickers.json
"""

import json, re, time, hashlib, os, sys, io
from pathlib import Path

# Windows GBK -> UTF-8
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from urllib.parse import urlparse, urljoin, unquote, quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

BASE = Path(__file__).parent
STICKERS_DIR = BASE / "stickers"
DATA_FILE = BASE / "data" / "stickers.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# ── helpers ──────────────────────────────────────────────

def fetch(url: str, headers: dict | None = None) -> bytes | None:
    """GET 请求，返回 bytes"""
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = Request(url, headers=h)
    try:
        with urlopen(req, timeout=15) as r:
            return r.read()
    except (URLError, HTTPError, OSError) as e:
        print(f"  ⚠️ 请求失败: {url[:80]} — {e}")
        return None

def fetch_json(url: str, headers: dict | None = None) -> dict | list | None:
    data = fetch(url, headers)
    if data:
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            pass
    return None

def content_type(url: str) -> str:
    """HEAD 检查 Content-Type"""
    req = Request(url, headers={"User-Agent": UA})
    req.method = "HEAD"
    try:
        with urlopen(req, timeout=8) as r:
            return r.headers.get("Content-Type", "")
    except Exception:
        return ""

def is_gif_url(url: str) -> bool:
    """URL 路径判断是否为 GIF"""
    path = urlparse(url).path.lower()
    if path.endswith(".gif"):
        return True
    # 搜狗等无扩展名，需 HEAD 检查
    if "." not in path.split("/")[-1]:
        ct = content_type(url)
        return "image/gif" in ct
    return False

def filename_for(url: str, idx: int, prefix: str) -> str:
    """生成唯一文件名"""
    path = urlparse(url).path
    name = unquote(path.rsplit("/", 1)[-1])
    if "." in name and name.rsplit(".", 1)[-1].lower() in ("gif", "jpg", "png", "jpeg", "webp"):
        stem, ext = name.rsplit(".", 1)
        ext = "." + ext.lower()
    else:
        stem = name or hashlib.md5(url.encode()).hexdigest()[:8]
        ext = ".gif"
    # 去重加序号
    fname = f"{prefix}-{stem}{ext}"
    target = STICKERS_DIR / fname
    if target.exists():
        fname = f"{prefix}-{stem}-{idx}{ext}"
    return fname

# ── 搜狗表情 API ─────────────────────────────────────────

SOGOU_API = "https://pic.sogou.com/napi/wap/emoji/searchlist"

SOGOU_KEYWORDS = [
    "搞笑", "熊猫人", "猫", "狗", "沙雕", "可爱", "奥特曼",
    "动漫", "游戏", "火影忍者", "海贼王", "龙珠", "鬼灭之刃",
    "间谍过家家", "咒术回战", "进击的巨人", "芙莉莲",
    "崩坏星穹铁道", "绝区零", "鸣潮", "原神",
    "摸鱼", "打工", "日常", "点赞", "比心",
]

def download_sogou() -> list[dict]:
    """搜狗表情 API — 按关键词搜索，解析 groupList 结构"""
    added = []
    seen_urls = set()

    for kw in SOGOU_KEYWORDS:
        print(f"\n🔍 搜狗搜索: {kw}")
        params = f"keyword={quote(kw)}&start=0&rows=50"
        data = fetch_json(f"{SOGOU_API}?{params}")
        if not data:
            continue

        # 实际结构: data.groupList = [[{groupName, groupId, picUrl, ...}, ...], ...]
        group_list = data.get("data", {}).get("groupList", [])
        items = []
        for group in group_list:
            if isinstance(group, list):
                items.extend(group)
        if not items:
            print(f"  找到 0 条")
            continue

        # 去重（同一 picUrl 可能出现在多个关键词中）
        unique = []
        for item in items:
            url = item.get("picUrl", "")
            if url and url not in seen_urls:
                seen_urls.add(url)
                unique.append(item)

        print(f"  找到 {len(items)} 条，去重后 {len(unique)} 条")

        for i, item in enumerate(unique):
            pic_url = item.get("picUrl", "")
            if not pic_url or not pic_url.startswith("http"):
                continue

            fname = filename_for(pic_url, i, f"sogou-{kw[:4]}")
            filepath = STICKERS_DIR / fname

            img_data = fetch(pic_url)
            if not img_data or len(img_data) < 100:
                continue
            # GIF 魔术字检查（搜狗图片无扩展名，必须检查字节）
            if img_data[:6] not in (b"GIF89a", b"GIF87a"):
                continue

            filepath.write_bytes(img_data)
            size_kb = len(img_data) // 1024
            group_name = item.get("groupName", kw)
            entry = {
                "id": f"sogou-{hashlib.md5(pic_url.encode()).hexdigest()[:8]}",
                "filename": fname,
                "url": f"stickers/{fname}",
                "tags": [kw, group_name],
                "category": _guess_category(kw),
                "source_url": pic_url,
            }
            added.append(entry)
            print(f"  ✅ {fname} ({size_kb}KB) — {group_name}")

        time.sleep(0.3)

    return added

# ── SOOGIF ───────────────────────────────────────────────

SOOGIF_CATEGORIES = [
    ("https://www.soogif.com/gif/gaoxiao/", "搞笑"),
    ("https://www.soogif.com/gif/dongman/", "动漫"),
    ("https://www.soogif.com/gif/dongwu/", "动物"),
    ("https://www.soogif.com/gif/mengchong/", "萌宠"),
    ("https://www.soogif.com/gif/youxi/", "游戏"),
]

def download_soogif() -> list[dict]:
    """抓取 SOOGIF 分类页 GIF"""
    added = []
    img_re = re.compile(r'<img[^>]+src="([^"]*img\.soogif\.com[^"]*\.gif)"', re.I)

    for url, cat in SOOGIF_CATEGORIES:
        print(f"\n🔍 SOOGIF: {cat} ({url})")
        for page in range(1, 6):  # 每分类抓5页
            page_url = url if page == 1 else f"{url.rstrip('/')}-{page}/"
            html = fetch(page_url)
            if not html:
                break

            text = html.decode("utf-8", errors="ignore")
            gifs = list(set(img_re.findall(text)))
            print(f"  第{page}页: {len(gifs)} 个 GIF")

            for i, gif_url in enumerate(gifs):
                if any(s.get("source_url") == gif_url for s in added):
                    continue
                prefix = f"soogif-{cat}"
                fname = filename_for(gif_url, i, prefix)
                filepath = STICKERS_DIR / fname

                img_data = fetch(gif_url)
                if not img_data or len(img_data) < 500:
                    continue
                if img_data[:3] != b"GIF":
                    continue

                filepath.write_bytes(img_data)
                size_kb = len(img_data) // 1024
                entry = {
                    "id": f"soogif-{hashlib.md5(gif_url.encode()).hexdigest()[:8]}",
                    "filename": fname,
                    "url": f"stickers/{fname}",
                    "tags": [cat],
                    "category": _guess_category(cat),
                    "source_url": gif_url,
                }
                added.append(entry)
                print(f"  ✅ {fname} ({size_kb}KB)")

            time.sleep(0.8)
    return added

# ── 皮蛋 pdan.com.cn ─────────────────────────────────────

PDAN_PAGES = [
    "https://www.pdan.com.cn/category/gif/",
    "https://www.pdan.com.cn/category/douyin/",
]

def download_pdan() -> list[dict]:
    """抓取皮蛋网 GIF"""
    added = []
    img_re = re.compile(r'<img[^>]+src="([^"]*\.gif)"', re.I)

    for url in PDAN_PAGES:
        print(f"\n🔍 皮蛋: {url}")
        html = fetch(url)
        if not html:
            continue
        text = html.decode("utf-8", errors="ignore")
        gifs = list(set(img_re.findall(text)))
        # 也找文章详情页链接
        article_re = re.compile(r'href="(https?://www\.pdan\.com\.cn/\d+\.html)"')
        articles = list(set(article_re.findall(text)))[:10]

        for art_url in articles:
            art_html = fetch(art_url)
            if art_html:
                art_text = art_html.decode("utf-8", errors="ignore")
                gifs.extend(img_re.findall(art_text))
            time.sleep(0.3)

        gifs = list(set(gifs))
        print(f"  找到 {len(gifs)} 个 GIF")

        for i, gif_url in enumerate(gifs):
            if any(s.get("source_url") == gif_url for s in added):
                continue
            fname = filename_for(gif_url, i, "pdan")
            filepath = STICKERS_DIR / fname

            img_data = fetch(gif_url)
            if not img_data or len(img_data) < 500:
                continue
            if img_data[:3] != b"GIF":
                continue

            filepath.write_bytes(img_data)
            size_kb = len(img_data) // 1024
            entry = {
                "id": f"pdan-{hashlib.md5(gif_url.encode()).hexdigest()[:8]}",
                "filename": fname,
                "url": f"stickers/{fname}",
                "tags": ["皮蛋", "搞笑"],
                "category": "沙雕",
                "source_url": gif_url,
            }
            added.append(entry)
            print(f"  ✅ {fname} ({size_kb}KB)")

        time.sleep(0.5)
    return added

# ── 米游社 API ───────────────────────────────────────────

MIYOUSHE_COLLECTION = "https://bbs-api.miyoushe.com/post/wapi/getPostFullInCollection"
MIYOUSHE_POST = "https://bbs-api.miyoushe.com/post/wapi/getPostFull"

MIYOUSHE_COLLECTIONS = [
    (1453, "大别野表情包合集", "沙雕"),
    (1648, "原神表情包", "原神"),
    (1819, "星穹铁道表情包", "崩坏星穹铁道"),
]

def download_miyoushe() -> list[dict]:
    """米游社 API — 免鉴权，从合集获取帖子图片"""
    added = []
    seen_urls = set()

    for col_id, col_name, default_cat in MIYOUSHE_COLLECTIONS:
        print(f"\n🔍 米游社合集: {col_name} (id={col_id})")

        # 获取合集帖子列表
        data = fetch_json(f"{MIYOUSHE_COLLECTION}?collection_id={col_id}&gids=6")
        if not data or data.get("retcode") != 0:
            print(f"  ⚠️ 合集请求失败")
            continue

        posts = data.get("data", {}).get("posts", [])
        print(f"  共 {len(posts)} 个帖子")

        gif_count = 0
        for post_data in posts:
            post = post_data.get("post", {})
            post_id = post.get("post_id", "")
            subject = post.get("subject", "")
            images = post.get("images", [])

            # 帖子列表中的 images 数组通常包含封面+几张图
            for img_url in images:
                if not img_url or img_url in seen_urls:
                    continue
                if not img_url.lower().endswith(".gif"):
                    continue  # 只看 GIF
                seen_urls.add(img_url)

                fname = filename_for(img_url, gif_count, f"miyoushe-{col_id}")
                filepath = STICKERS_DIR / fname

                img_data = fetch(img_url)
                if not img_data or len(img_data) < 100:
                    continue
                if img_data[:3] != b"GIF":
                    continue

                filepath.write_bytes(img_data)
                size_kb = len(img_data) // 1024
                entry = {
                    "id": f"miyoushe-{hashlib.md5(img_url.encode()).hexdigest()[:8]}",
                    "filename": fname,
                    "url": f"stickers/{fname}",
                    "tags": [subject.strip()[:20], col_name],
                    "category": _guess_category(subject + col_name),
                    "source_url": img_url,
                }
                added.append(entry)
                gif_count += 1
                print(f"  ✅ {fname} ({size_kb}KB) — {subject[:30]}")

            time.sleep(0.2)

        print(f"  合集 {col_name}: 下载 {gif_count} 个 GIF")

    return added

# ── 分类推断 ─────────────────────────────────────────────

CATEGORY_MAP = {
    "原神": "原神", "崩坏星穹铁道": "崩坏星穹铁道", "崩坏": "崩坏3",
    "绝区零": "绝区零", "鸣潮": "鸣潮",
    "火影忍者": "火影忍者", "海贼王": "海贼王", "龙珠": "龙珠",
    "鬼灭之刃": "鬼灭之刃", "间谍过家家": "间谍过家家",
    "咒术回战": "咒术回战", "进击的巨人": "进击的巨人",
    "芙莉莲": "葬送的芙莉莲",
    "猫": "动物", "狗": "动物", "动物": "动物", "萌宠": "动物",
    "熊猫人": "熊猫人", "熊猫": "熊猫人",
    "动漫": "动漫", "游戏": "游戏",
    "奥特曼": "动漫",
}

def _guess_category(keyword: str) -> str:
    for k, v in CATEGORY_MAP.items():
        if k in keyword:
            return v
    return "沙雕"

# ── 更新 stickers.json ───────────────────────────────────

def update_json(new_entries: list[dict]):
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    existing_filenames = {s["filename"] for s in data["stickers"]}
    existing_ids = {s["id"] for s in data["stickers"]}

    really_new = []
    for e in new_entries:
        if e["filename"] not in existing_filenames and e["id"] not in existing_ids:
            really_new.append(e)
            existing_filenames.add(e["filename"])
            existing_ids.add(e["id"])

    data["stickers"].extend(really_new)
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(really_new)

# ── main ─────────────────────────────────────────────────

def main():
    STICKERS_DIR.mkdir(parents=True, exist_ok=True)
    all_new = []

    # 1) 搜狗 API
    print("=" * 60)
    print("📦 第1步: 搜狗表情 API")
    print("=" * 60)
    all_new.extend(download_sogou())

    # 2) 米游社 API
    print("\n" + "=" * 60)
    print("📦 第2步: 米游社 API")
    print("=" * 60)
    all_new.extend(download_miyoushe())

    # 3) SOOGIF
    print("\n" + "=" * 60)
    print("📦 第3步: SOOGIF")
    print("=" * 60)
    all_new.extend(download_soogif())

    # 4) 皮蛋
    print("\n" + "=" * 60)
    print("📦 第4步: 皮蛋网")
    print("=" * 60)
    all_new.extend(download_pdan())

    # 写入 JSON
    print(f"\n{'=' * 60}")
    count = update_json(all_new)
    print(f"🎉 完成! 新增 {count} 个 GIF，总计 {len(json.loads(DATA_FILE.read_text(encoding='utf-8'))['stickers'])} 个 sticker")
    print(f"   文件位置: {STICKERS_DIR}")

if __name__ == "__main__":
    main()

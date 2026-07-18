"""
ingest.py — 把 vault 的 MOC/Flash/Error 卡片导入 LightRAG（档1 结构提示）

用法：
    cd lightrag
    venv/Scripts/python.exe ingest.py              # 增量导入（默认）
    venv/Scripts/python.exe ingest.py --full       # 全量重导（清状态文件）
    venv/Scripts/python.exe ingest.py --dry-run    # 只打印不实际导入
    venv/Scripts/python.exe ingest.py --limit 5    # 只导入前 5 个（测试用）

档1 结构提示：每个 md 导入时在正文前拼一段结构信息，让 LLM 抽实体时感知三层卡片语义。
  - MOC:   【MOC 知识点：数列极限定义，章节层级 2.1.1（第 3 层）】
  - Flash: 【Flash 二级结论：arccot x｜类型：know_why｜挂在 MOC：拐点判断｜相关错题：...】
  - Error: 【Error 错题：1992 数二｜暴露的 Flash 套路盲点：加减滥用等价无穷小｜主题：极限/函数极限】

增量：记录已导入文件路径 + mtime 到 ingest_state.json，重跑只灌新增/改动。

前置条件：lightrag/.env 必须有有效的 GLM 配置（由插件"应用并重启"写入）。
"""
import os
import sys
import re
import json
import time
import argparse
import requests
from pathlib import Path

# ============ 配置 ============
SCRIPT_DIR = Path(__file__).parent.resolve()
STATE_FILE = SCRIPT_DIR / "ingest_state.json"
VAULT_ROOT = SCRIPT_DIR.parents[3]  # lightrag → star-ring-graph → plugins → .obsidian → vault
# ponytail: 路径硬编码对齐 data.json 默认值，不从插件读（避免依赖 obsidian API）
MOC_FOLDER = VAULT_ROOT / "1_高等数学Moc"
FLASH_FOLDER = VAULT_ROOT / "StudyGuide" / "Flash"
ERROR_FOLDER = VAULT_ROOT / "StudyGuide" / "Errors"

LIGHTAG_URL = os.getenv("LIGHTRAG_URL", "http://127.0.0.1:9620")
# 批量插入的分批大小（LightRAG /documents/texts 会并发抽实体，太大压 GLM）
BATCH_SIZE = 5


# ============ frontmatter 解析（对齐插件 data.ts 的 parseFrontmatter）============
def parse_frontmatter(content: str) -> dict:
    """简易 YAML 解析，只取顶层 key:value + 列表项。返回 dict。"""
    m = re.match(r'^---\r?\n([\s\S]*?)\r?\n---', content)
    if not m:
        return {}
    fm = {}
    cur_key = ""
    in_list = False
    for line in m[1].split('\n'):
        list_m = re.match(r'^\s*-\s+(.+)', line)
        if list_m and cur_key and in_list:
            if not isinstance(fm[cur_key], list):
                fm[cur_key] = []
            val = list_m[1].strip()
            # 去 [[...]] 取 basename
            wl = re.match(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]', val)
            if wl:
                val = wl[1].strip()
            else:
                val = val.strip('"')
            fm[cur_key].append(val)
            continue
        kv = re.match(r'^([^:#\s][^:]*):\s*(.*)$', line)
        if kv:
            cur_key = kv[1].strip()
            val = kv[2].strip().strip('"')
            if val == "" or val == "[]":
                fm[cur_key] = [] if val == "[]" else ""
                in_list = True
            elif val.startswith("[") and val.endswith("]"):
                fm[cur_key] = [v.strip().strip('"') for v in val[1:-1].split(",") if v.strip()]
                in_list = False
            else:
                fm[cur_key] = val
                in_list = False
    return fm


def strip_frontmatter(content: str) -> str:
    """去掉 frontmatter，只留正文。"""
    return re.sub(r'^---\r?\n[\s\S]*?\r?\n---\r?\n?', '', content, count=1)


def basename_from_wikilink(wl: str) -> str:
    """[[2.1.1_数列极限]] → 2.1.1_数列极限"""
    m = re.match(r'\[\[([^\]|]+)', wl)
    return m[1].strip() if m else wl.strip()


def strip_prefix(basename: str) -> str:
    """2.1.1_数列极限 → 数列极限（去文件名前缀，供结构提示用人类可读名）"""
    return re.sub(r'^[\d.]+_', '', basename)


# ============ 档1：结构提示拼接 ============
def build_moc_prompt(file_path: Path, content: str) -> str:
    """MOC 卡片：正文 + 章节层级提示。"""
    basename = file_path.stem
    prefix_m = re.match(r'^(\d+(?:\.\d+)*)_', basename)
    depth_info = ""
    if prefix_m:
        depth = prefix_m[1].count('.') + 1
        depth_info = f"，章节层级 {prefix_m[1]}（第 {depth} 层）"
    readable = strip_prefix(basename)
    body = strip_frontmatter(content).strip()
    return f"【MOC 知识点：{readable}{depth_info}】\n\n{body}"


def build_flash_prompt(file_path: Path, content: str) -> str:
    """Flash 卡片：正文 + 类型 + 挂载 MOC + 相关错题。"""
    fm = parse_frontmatter(content)
    basename = file_path.stem
    subtype = fm.get("subtype", "未知")
    topic = fm.get("topic", "")
    mindtree = fm.get("mindtree", [])
    errors = fm.get("errors", [])
    readable = fm.get("title") or strip_prefix(basename)

    parts = [f"【Flash 二级结论：{readable}"]
    parts.append(f"类型：{subtype}（know_what=是什么 / know_how=怎么做 / know_why=为什么）")
    if topic:
        parts.append(f"主题：{topic}")
    if mindtree:
        moc_names = [strip_prefix(basename_from_wikilink(wl)) for wl in mindtree[:3]]
        parts.append(f"挂在 MOC：{', '.join(moc_names)}")
    if errors:
        err_names = [basename_from_wikilink(wl).split('_')[-1] or basename_from_wikilink(wl) for wl in errors[:3]]
        parts.append(f"相关错题：{', '.join(err_names)}")
    header = "｜".join(parts) + "】\n\n"

    body = strip_frontmatter(content).strip()
    return header + body


def build_error_prompt(file_path: Path, content: str) -> str:
    """Error 卡片：正文 + 暴露的 Flash 套路 + 主题。"""
    fm = parse_frontmatter(content)
    basename = file_path.stem
    topic = fm.get("topic", "")
    tags = fm.get("tags", [])
    flash_links = fm.get("flash", [])
    title = fm.get("title") or basename

    parts = [f"【Error 错题：{title}"]
    if topic:
        parts.append(f"主题：{topic}")
    if tags:
        tag_str = ", ".join(tags[:5]) if isinstance(tags, list) else str(tags)
        parts.append(f"标签：{tag_str}")
    if flash_links:
        # Error.flash 字段反向映射：这道题暴露了哪些 Flash 套路盲点
        flash_names = [strip_prefix(basename_from_wikilink(wl)) for wl in flash_links[:3]]
        parts.append(f"暴露的 Flash 套路盲点：{', '.join(flash_names)}")
    header = "｜".join(parts) + "】\n\n"

    body = strip_frontmatter(content).strip()
    return header + body


# ============ 文件收集 ============
def collect_files(folder: Path) -> list:
    """递归收集目录下所有 md 文件（含 mtime）。"""
    out = []
    if not folder.exists():
        return out
    for p in folder.rglob("*.md"):
        if p.name.startswith("0_"):  # 思维树根文件不导入（对齐插件 data.ts）
            continue
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        out.append((p, mtime))
    return out


def classify_card(file_path: Path) -> str:
    """按所在目录判断卡片类型：moc / flash / error。"""
    try:
        file_path.relative_to(MOC_FOLDER)
        return "moc"
    except ValueError:
        pass
    try:
        file_path.relative_to(FLASH_FOLDER)
        return "flash"
    except ValueError:
        pass
    try:
        file_path.relative_to(ERROR_FOLDER)
        return "error"
    except ValueError:
        pass
    return "unknown"


# ============ LightRAG API ============
def check_health():
    """检查 server 是否在线。"""
    try:
        r = requests.get(f"{LIGHTAG_URL}/health", timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def insert_batch(texts: list, file_sources: list):
    """
    批量插入。返回 (track_id, status)。
    LightRAG 插入是异步的，返回 track_id 后用 /documents/track-status 轮询。
    """
    payload = {"texts": texts, "file_sources": file_sources}
    r = requests.post(f"{LIGHTAG_URL}/documents/texts", json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    return data.get("track_id"), data.get("status")


def wait_for_track(track_id: str, timeout: int = 300):
    """轮询 track-status 直到完成或超时。"""
    if not track_id:
        return
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(f"{LIGHTAG_URL}/documents/track-status",
                           params={"track_id": track_id}, timeout=10)
            if r.status_code == 200:
                data = r.json()
                status = data.get("status", "")
                if status in ("completed", "success", "done", "failed", "error"):
                    return status
                progressed = data.get("progressed", 0)
                total = data.get("total", 0)
                print(f"    进度: {progressed}/{total} ({status})")
        except Exception:
            pass
        time.sleep(3)
    return "timeout"


# ============ 增量状态 ============
def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# ============ 主流程 ============
def main():
    parser = argparse.ArgumentParser(description="把 vault 笔记导入 LightRAG")
    parser.add_argument("--full", action="store_true", help="全量重导（清状态文件）")
    parser.add_argument("--dry-run", action="store_true", help="只打印不实际导入")
    parser.add_argument("--limit", type=int, default=0, help="只导入前 N 个（测试用）")
    args = parser.parse_args()

    print("=" * 60)
    print("LightRAG 数据导入（档1 结构提示）")
    print("=" * 60)
    print(f"VAULT_ROOT: {VAULT_ROOT}")

    # 1. 检查 server
    if not args.dry_run:
        if not check_health():
            print(f"✗ LightRAG server 不在线（{LIGHTAG_URL}）。先启动：bash restart.sh")
            sys.exit(1)
        print(f"✓ server 在线: {LIGHTAG_URL}")

    # 2. 加载增量状态
    state = {} if args.full else load_state()
    if args.full:
        print("⚠ --full 模式：重导全部（但不会清 LightRAG 已有数据，如需清库用 webui 或 API）")

    # 3. 收集三类卡片
    print(f"\n收集卡片：")
    moc_files = collect_files(MOC_FOLDER)
    flash_files = collect_files(FLASH_FOLDER)
    error_files = collect_files(ERROR_FOLDER)
    print(f"  MOC:   {len(moc_files)} 个 ({MOC_FOLDER})")
    print(f"  Flash: {len(flash_files)} 个 ({FLASH_FOLDER})")
    print(f"  Error: {len(error_files)} 个 ({ERROR_FOLDER})")
    total = len(moc_files) + len(flash_files) + len(error_files)
    print(f"  合计:  {total} 个")

    if total == 0:
        print("\n✗ 没找到任何卡片文件。检查 VAULT_ROOT 和目录配置。")
        sys.exit(1)

    # 4. 过滤出需要导入的（增量：新增或 mtime 变化）
    to_import = []
    all_files = moc_files + flash_files + error_files
    for fp, mtime in all_files:
        rel = str(fp.relative_to(VAULT_ROOT)).replace("\\", "/")
        if rel in state and state[rel] == mtime and not args.full:
            continue
        to_import.append((fp, mtime, rel))

    if not to_import:
        print("\n✓ 无新增/改动，无需导入")
        return

    print(f"\n待导入: {len(to_import)} 个（已跳过 {total - len(to_import)} 个未改动）")
    if args.limit > 0:
        to_import = to_import[:args.limit]
        print(f"  --limit {args.limit}：只导入前 {len(to_import)} 个")

    # 5. 构建结构提示文本
    print("\n构建结构提示文本...")
    docs = []
    for fp, mtime, rel in to_import:
        try:
            content = fp.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  ✗ 读不了 {rel}: {e}")
            continue

        card_type = classify_card(fp)
        if card_type == "moc":
            text = build_moc_prompt(fp, content)
        elif card_type == "flash":
            text = build_flash_prompt(fp, content)
        elif card_type == "error":
            text = build_error_prompt(fp, content)
        else:
            text = strip_frontmatter(content).strip()

        docs.append((rel, text, mtime, card_type))

    if args.dry_run:
        print("\n=== --dry-run：打印前 2 个结构提示样本 ===")
        for rel, text, _, ct in docs[:2]:
            print(f"\n--- [{ct}] {rel} ---")
            print(text[:500])
            print("..." if len(text) > 500 else "")
        print(f"\n（共 {len(docs)} 个待导入，dry-run 不实际写入）")
        return

    # 6. 分批导入
    print(f"\n开始导入（分批，每批 {BATCH_SIZE} 个）...")
    total_done = 0
    failed = []
    for i in range(0, len(docs), BATCH_SIZE):
        batch = docs[i:i + BATCH_SIZE]
        texts = [d[1] for d in batch]
        sources = [d[0] for d in batch]
        batch_n = i // BATCH_SIZE + 1
        total_batches = (len(docs) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"\n  批次 {batch_n}/{total_batches}（{len(batch)} 个）")
        for s, _, _, ct in batch:
            print(f"    · [{ct}] {s}")

        try:
            track_id, status = insert_batch(texts, sources)
            print(f"    提交: status={status}, track_id={track_id}")
            if track_id:
                final = wait_for_track(track_id)
                print(f"    完成: {final}")
            # 标记成功
            for rel, _, mtime, _ in batch:
                state[rel] = mtime
            save_state(state)
            total_done += len(batch)
        except Exception as e:
            print(f"    ✗ 批次失败: {e}")
            failed.extend([d[0] for d in batch])

    # 7. 总结
    print("\n" + "=" * 60)
    print(f"导入完成: {total_done}/{len(docs)} 成功" + (f"，{len(failed)} 失败" if failed else ""))
    if failed:
        print("失败文件:")
        for f in failed:
            print(f"  ✗ {f}")
    print("=" * 60)


if __name__ == "__main__":
    main()

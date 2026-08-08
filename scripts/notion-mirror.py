#!/usr/bin/env python3
"""Mirror a markdown file into a Notion page: wipe children, convert, append."""
import json, os, re, sys, time, urllib.request, urllib.error

TOK = os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN") or os.environ.get("NOTION_SECRET")
VER = "2022-06-28"
API = "https://api.notion.com/v1"


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOK}")
    req.add_header("Notion-Version", VER)
    req.add_header("Content-Type", "application/json")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            payload = e.read().decode()
            if e.code in (429, 502, 503) and attempt < 4:
                time.sleep(2 * (attempt + 1)); continue
            raise SystemExit(f"HTTP {e.code} on {method} {path}: {payload[:600]}")
    raise SystemExit("retries exhausted")


INLINE = re.compile(r"(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|<https?://[^>]+>)")


def rich(text, max_len=1900):
    """Markdown inline -> Notion rich_text, splitting oversized runs."""
    out = []
    for part in INLINE.split(text):
        if not part:
            continue
        ann, content, link = {}, part, None
        m = re.fullmatch(r"\[([^\]]+)\]\(([^)]+)\)", part)
        if m:
            content, link = m.group(1), m.group(2)
        elif re.fullmatch(r"`[^`]+`", part):
            content, ann = part[1:-1], {"code": True}
        elif re.fullmatch(r"\*\*[^*]+\*\*", part):
            content, ann = part[2:-2], {"bold": True}
        elif re.fullmatch(r"<https?://[^>]+>", part):
            content = link = part[1:-1]
        content = content.replace("**", "")
        while content:
            chunk, content = content[:max_len], content[max_len:]
            item = {"type": "text", "text": {"content": chunk}}
            if link:
                item["text"]["link"] = {"url": link}
            if ann:
                item["annotations"] = ann
            out.append(item)
    return out or [{"type": "text", "text": {"content": ""}}]


def block(t, **kw):
    return {"object": "block", "type": t, t: kw}


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def convert(md):
    lines = md.split("\n")
    blocks, i = [], 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()

        if not s:
            i += 1; continue

        if s.startswith("```"):
            lang = s[3:].strip() or "plain text"
            body, i = [], i + 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                body.append(lines[i]); i += 1
            i += 1
            blocks.append(block("code", rich_text=[{"type": "text", "text": {"content": "\n".join(body)[:1900]}}],
                                language=lang if lang in ("json", "bash", "shell", "typescript", "javascript", "http") else "plain text"))
            continue

        if re.fullmatch(r"-{3,}", s):
            blocks.append(block("divider")); i += 1; continue

        m = re.match(r"^(#{1,3})\s+(.*)", s)
        if m:
            lvl = len(m.group(1))
            blocks.append(block(f"heading_{lvl}", rich_text=rich(m.group(2)), is_toggleable=False))
            i += 1; continue

        # table
        if s.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            header = split_row(s)
            rows, i = [header], i + 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                r = split_row(lines[i].strip())
                r = (r + [""] * len(header))[:len(header)]
                rows.append(r); i += 1
            blocks.append(block("table", table_width=len(header), has_column_header=True, has_row_header=False,
                                children=[{"object": "block", "type": "table_row",
                                           "table_row": {"cells": [rich(c) for c in r]}} for r in rows]))
            continue

        m = re.match(r"^[-*]\s+(.*)", s)
        if m:
            blocks.append(block("bulleted_list_item", rich_text=rich(m.group(1)))); i += 1; continue

        m = re.match(r"^\d+\.\s+(.*)", s)
        if m:
            blocks.append(block("numbered_list_item", rich_text=rich(m.group(1)))); i += 1; continue

        if s.startswith(">"):
            blocks.append(block("quote", rich_text=rich(s.lstrip("> ")))); i += 1; continue

        para = [s]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,3}\s|[-*]\s|\d+\.\s|\||>|```|-{3,}$)", lines[i].strip()):
            para.append(lines[i].strip()); i += 1
        blocks.append(block("paragraph", rich_text=rich(" ".join(para))))
    return blocks


def main():
    page_id, path = sys.argv[1], sys.argv[2]
    # wipe
    removed = 0
    while True:
        res = call("GET", f"/blocks/{page_id}/children?page_size=100")
        kids = res.get("results", [])
        if not kids:
            break
        for k in kids:
            call("DELETE", f"/blocks/{k['id']}"); removed += 1
        if not res.get("has_more"):
            break
    blocks = convert(open(path).read())
    for n in range(0, len(blocks), 90):
        call("PATCH", f"/blocks/{page_id}/children", {"children": blocks[n:n + 90]})
    print(f"deleted={removed} appended={len(blocks)}")


if __name__ == "__main__":
    main()

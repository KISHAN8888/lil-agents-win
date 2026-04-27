import sys
import json
import logging
from typing import Any, Dict, List, Optional
import os
from pathlib import Path
import hashlib
import uuid
import time
import re
import yaml
import requests
import trafilatura
import shutil
from pypdf import PdfReader
from docx import Document
from llm import call_llm_json, call_llm
from related import find_related

# Set up logging to stderr so it doesn't interfere with NDJSON on stdout
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger("worker")

def send_event(event: str, **kwargs: Any) -> None:
    """Sends an NDJSON event to stdout."""
    msg = {"event": event, **kwargs}
    print(json.dumps(msg), flush=True)

def load_config(vault_path: Path) -> Dict[str, Any]:
    config_path = vault_path / ".sage/config.yaml"
    if config_path.exists():
        try:
            with open(config_path, "r") as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.error(f"Failed to load config: {e}")
    return {"llm_provider": "claude"} # Default

def update_vault_config(vault_path: Path, new_config: Dict[str, Any]) -> None:
    try:
        config_path = vault_path / ".sage/config.yaml"
        config = load_config(vault_path)
        config.update(new_config)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(config_path, "w") as f:
            yaml.dump(config, f)
        logger.info(f"Updated vault config: {config}")
    except Exception as e:
        logger.error(f"Failed to update vault config: {e}")

def get_prompt(name: str, **kwargs: str) -> str:
    if hasattr(sys, '_MEIPASS'):
        # PyInstaller path
        base_path = Path(sys._MEIPASS) / "prompts"
    else:
        base_path = Path(__file__).parent / "prompts"
    
    prompt_path = base_path / f"{name}.txt"
    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt template not found: {prompt_path}")
    
    text = prompt_path.read_text(encoding="utf-8")
    for k, v in kwargs.items():
        text = text.replace(f"{{{{{k}}}}}", str(v))
    return text

def handle_command(cmd_msg: Dict[str, Any]) -> None:
    """Processes a command from the main process."""
    cmd = cmd_msg.get("cmd")
    
    if cmd == "status":
        send_event("log", level="info", message="worker alive")
    elif cmd == "init_vault":
        vault_path = cmd_msg.get("path")
        provider = cmd_msg.get("provider", "claude")
        if not vault_path:
            send_event("log", level="error", message="No path provided for init_vault")
            return
        init_vault(vault_path, provider)
    elif cmd == "ingest":
        init_ingest(cmd_msg)
    elif cmd == "compile_now":
        vault_path = cmd_msg.get("vault_path")
        if not vault_path:
            send_event("log", level="error", message="No path provided for compile_now")
            return
        run_stitch_pass(Path(vault_path))
    elif cmd == "get_context":
        vault_path = cmd_msg.get("vault_path")
        query = cmd_msg.get("query")
        if not vault_path or not query:
            send_event("context_result", context="")
            return
        get_context(Path(vault_path), query)
    elif cmd == "update_config":
        vault_path = cmd_msg.get("vault_path")
        new_config = cmd_msg.get("config")
        if vault_path and new_config:
            update_vault_config(Path(vault_path), new_config)
    elif cmd == "shutdown":
        logger.info("Shutdown command received")
        sys.exit(0)
    else:
        logger.warning(f"Unknown command: {cmd}")
        send_event("log", level="warn", message=f"Unknown command: {cmd}")

def init_ingest(cmd_msg: Dict[str, Any]) -> None:
    try:
        kind = cmd_msg.get("kind")
        path = cmd_msg.get("path")
        caption = cmd_msg.get("caption", "")
        vault_path_str = cmd_msg.get("vault_path")
        
        if (not path and kind != "text") or not vault_path_str:
            send_event("task_failed", error="Missing path or vault_path")
            return
            
        root = Path(vault_path_str)
        config = load_config(root)
        provider = config.get("llm_provider", "claude")
        
        # Phase 1: Validate / Pre-screen
        content = ""
        src_path = None
        secret_pattern = re.compile(r"\b(?:pwd|pass(word)?|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S+", re.IGNORECASE)

        if kind == "file":
            src_path = Path(path)
            if not src_path.exists():
                send_event("task_failed", error=f"File not found: {path}")
                return
            ext = src_path.suffix.lower()
            
            # Phase 2: Extract
            if ext == ".pdf":
                reader = PdfReader(src_path)
                content = "\n".join([page.extract_text() for page in reader.pages])
            elif ext == ".docx":
                doc = Document(src_path)
                content = "\n".join([para.text for para in doc.paragraphs])
            elif ext in [".txt", ".md"]:
                content = src_path.read_text(encoding="utf-8", errors="replace")
            else:
                send_event("task_failed", error=f"Unsupported file type: {ext}")
                return
                
        elif kind == "url":
            downloaded = trafilatura.fetch_url(path)
            content = trafilatura.extract(downloaded) or ""
            if len(content) < 200:
                content = f"URL: {path}\n(Content too short for extraction)"
        elif kind == "text":
            content = cmd_msg.get("text", "")
            if not content:
                send_event("task_failed", error="Empty text ingest")
                return
        
        if secret_pattern.search(content):
            send_event("task_failed", error="Password or secret detected. Ingest refused.")
            return

        # Phase 3: Dedupe (Simplified)
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        
        # Staging
        task_id = str(uuid.uuid4())
        staging_dir = root / ".sage/staging" / task_id
        staging_dir.mkdir(parents=True, exist_ok=True)
        
        # Phase 4: Classify
        classify_prompt = get_prompt("classify", CONTENT=content[:5000])
        classification = call_llm_json(provider, classify_prompt)
        if not classification:
            classification = {"class": "note", "confidence": 0, "title": src_path.stem if src_path else "Note"}
        
        if classification.get("is_password_or_secret"):
            send_event("task_failed", error="Password or secret detected by LLM. Ingest refused.")
            return

        cls = classification.get("class", "note")
        
        # Phase 5: Summarize
        summary_data = None
        if cls not in ["todo", "reminder", "fact_about_user", "watchlist", "buylist"]:
            summarize_prompt = get_prompt("summarize", CONTENT=content[:10000])
            summary_data = call_llm_json(provider, summarize_prompt)
        
        if not summary_data:
            summary_data = {"summary": "", "keywords": [], "entities": []}

        # Phase 6: Find Related
        related_paths = find_related(root, summary_data.get("keywords", []))

        # Phase 7: Write Article
        class_to_dir = {
            "fact_about_user": "people/me.md",
            "todo": "todos.md",
            "watchlist": "lists/watchlist.md",
            "buylist": "lists/buylist.md",
            "reminder": "reminders.md",
            "note": "notes",
            "paper": "papers",
            "web": "web",
            "reference": "clips"
        }
        
        target_sub = class_to_dir.get(cls, "notes")
        if target_sub.endswith(".md"):
            target_rel_path = f"wiki/{target_sub}"
            target_path = root / target_rel_path
        else:
            default_title = src_path.stem if src_path else "note"
            slug = classification.get("title", default_title).lower().replace(" ", "-")
            slug = re.sub(r"[^a-z0-9-]", "", slug)
            target_rel_path = f"wiki/{target_sub}/{slug}.md"
            target_path = root / target_rel_path
            counter = 1
            while target_path.exists():
                target_rel_path = f"wiki/{target_sub}/{slug}-{counter}.md"
                target_path = root / target_rel_path
                counter += 1

        if cls in ["todo", "reminder", "fact_about_user", "watchlist", "buylist"]:
            # Fast path: deterministic markdown
            article_body = f"\n{content}\n"
        else:
            # LLM path
            write_prompt = get_prompt("write_article", 
                TARGET_PATH=target_rel_path,
                EXTRACTED=content[:20000],
                CLASS=cls,
                SUMMARY=summary_data.get("summary", ""),
                CAPTION=caption,
                RELATED_LIST=json.dumps(related_paths)
            )
            article_body = call_llm(provider, write_prompt) or content
            
        frontmatter = {
            "title": classification.get("title", src_path.stem if src_path else "Note"),
            "type": cls,
            "created_by": "kim",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sources": [{
                "kind": kind,
                "path": str(src_path) if src_path else path,
                "hash": content_hash
            }],
            "keywords": summary_data.get("keywords", []),
            "entities": summary_data.get("entities", [])
        }
        if caption:
            frontmatter["caption"] = caption
            
        article_full = "---\n" + yaml.dump(frontmatter, sort_keys=False) + "---\n\n"
        article_full += article_body
        
        staged_article = staging_dir / "article.md"
        staged_article.write_text(article_full, encoding="utf-8")
        
        # Phase 10: Commit
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if cls in ["todo", "reminder", "fact_about_user", "watchlist", "buylist"] and target_path.exists():
            with open(target_path, "a", encoding="utf-8") as f:
                f.write(f"\n- [ ] {content} (from {src_path.name if src_path else 'text'})\n")
        else:
            staged_article.replace(target_path)

        # Phase 8: Propagate Entity Updates
        entities = summary_data.get("entities", [])
        for ent in entities:
            slug = ent.lower().replace(" ", "-")
            ent_path = None
            for d in ["people", "concepts"]:
                p = root / f"wiki/{d}/{slug}.md"
                if p.exists():
                    ent_path = p
                    break
            
            if ent_path:
                update_entities(root, ent_path, target_rel_path, article_body, provider)

        # Update Backlinks on related articles
        for rel in related_paths:
            rel_abs = root / rel
            if rel_abs.exists() and rel_abs.suffix == ".md":
                append_backlink(rel_abs, target_rel_path, frontmatter["title"])
        
        # Update INDEX.md
        update_index(root)

        # Append to log.md
        append_log(root, "ingest", frontmatter["title"], 
                  source=str(src_path) if src_path else path,
                  routed=target_rel_path,
                  llm=f"{provider} (3 calls)")

        # Cleanup staging
        def remove_readonly(func, p, _):
            os.chmod(p, 0o777)
            func(p)
            
        try:
            shutil.rmtree(staging_dir, onerror=remove_readonly)
        except Exception as e:
            logger.warning(f"Failed to cleanup staging dir {staging_dir}: {e}")
        
        send_event("task_completed", status="success", path=str(target_path))
    except Exception as e:
        logger.exception("Ingest failed")
        send_event("task_failed", error=str(e))

def update_entities(root: Path, ent_path: Path, new_article_rel: str, new_article_content: str, provider: str) -> None:
    try:
        current_content = ent_path.read_text(encoding="utf-8")
        prompt = get_prompt("entity_update",
            ENTITY_PATH=str(ent_path.relative_to(root)),
            ENTITY_CURRENT_CONTENT=current_content[:10000],
            NEW_ARTICLE_PATH=new_article_rel,
            NEW_ARTICLE_CONTENT=new_article_content[:10000]
        )
        
        result = call_llm_json(provider, prompt)
        if result and result.get("should_update") and result.get("updated_content"):
            ent_path.write_text(result["updated_content"], encoding="utf-8")
            logger.info(f"Updated entity page: {ent_path}")
        
        if result and result.get("contradiction"):
            c = result["contradiction"]
            if c.get("old_claim") and c.get("new_claim"):
                send_event("contradiction_flagged", 
                          entity=ent_path.stem,
                          old_claim=c["old_claim"],
                          new_claim=c["new_claim"],
                          sources=[new_article_rel, str(ent_path.relative_to(root))])
    except Exception as e:
        logger.error(f"Failed to update entity {ent_path}: {e}")

def get_context(root: Path, query: str) -> None:
    try:
        words = sorted([w for w in query.split() if len(w) > 3], key=len, reverse=True)
        keywords = words[:5]
        related = find_related(root, keywords)
        
        context_parts = []
        for rel in related[:3]:
            rel_path = root / rel
            if rel_path.exists():
                content = rel_path.read_text(encoding="utf-8")
                if content.startswith("---"):
                    fm_end = content.find("---", 3)
                    if fm_end != -1:
                        content = content[fm_end+3:].strip()
                context_parts.append(f"Source: {rel}\n{content[:2000]}")
        
        context_str = "\n\n---\n\n".join(context_parts)
        send_event("context_result", context=context_str)
    except Exception as e:
        logger.error(f"get_context failed: {e}")
        send_event("context_result", context="")

def append_backlink(target_file: Path, from_path: str, from_title: str) -> None:
    try:
        content = target_file.read_text(encoding="utf-8")
        marker_start = "<!-- kim:backlinks-start -->"
        marker_end = "<!-- kim:backlinks-end -->"
        backlink_line = f"- [[{from_path}]] — {from_title}"
        
        if marker_start in content and marker_end in content:
            parts = content.split(marker_start)
            pre = parts[0]
            rest = parts[1].split(marker_end)
            mid = rest[0]
            post = rest[1]
            if from_path not in mid:
                new_mid = mid.strip() + "\n" + backlink_line + "\n"
                new_content = pre + marker_start + "\n" + new_mid + marker_end + post
                target_file.write_text(new_content, encoding="utf-8")
        else:
            new_content = content.strip() + "\n\n## Backlinks\n" + marker_start + "\n" + backlink_line + "\n" + marker_end + "\n"
            target_file.write_text(new_content, encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to append backlink to {target_file}: {e}")

def update_index(root: Path) -> None:
    wiki_dir = root / "wiki"
    index_path = wiki_dir / "INDEX.md"
    lines = ["# Wiki Index\n", f"Generated on {time.strftime('%Y-%m-%d %H:%M:%S')}\n"]
    dirs = ["papers", "web", "notes", "concepts", "people", "clips"]
    for d in dirs:
        d_path = wiki_dir / d
        if d_path.exists() and d_path.is_dir():
            lines.append(f"\n## {d.capitalize()}\n")
            files = sorted(list(d_path.glob("*.md")), key=lambda x: x.stat().st_mtime, reverse=True)
            for f in files:
                if f.name == "INDEX.md": continue
                title = f.stem
                try:
                    content = f.read_text(encoding="utf-8")
                    if content.startswith("---"):
                        fm_end = content.find("---", 3)
                        if fm_end != -1:
                            fm = yaml.safe_load(content[3:fm_end])
                            title = fm.get("title", title)
                except: pass
                rel = str(f.relative_to(root)).replace("\\", "/")
                lines.append(f"- [[{rel}]] — {title}")
    index_path.write_text("\n".join(lines), encoding="utf-8")

def append_log(root: Path, kind: str, title: str, **kwargs: str) -> None:
    log_path = root / "wiki/log.md"
    ts = time.strftime("%Y-%m-%d %H:%M")
    entry = [f"## [{ts}] {kind} | {title}"]
    for k, v in kwargs.items():
        entry.append(f"- {k}: {v}")
    entry.append("")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write("\n".join(entry) + "\n")

def run_stitch_pass(root: Path) -> None:
    try:
        logger.info("Starting stitch pass...")
        send_event("log", level="info", message="Starting stitch pass...")
        update_index(root)
        config = load_config(root)
        provider = config.get("llm_provider", "claude")
        recent_articles = []
        wiki_dir = root / "wiki"
        for p in wiki_dir.glob("**/*.md"):
            if p.name == "INDEX.md" or p.name == "log.md": continue
            recent_articles.append(p)
        recent_articles.sort(key=lambda x: x.stat().st_mtime, reverse=True)
        recent_list = []
        for p in recent_articles[:20]:
            try:
                content = p.read_text(encoding="utf-8")
                title = p.stem
                summary = ""
                if content.startswith("---"):
                    fm_end = content.find("---", 3)
                    if fm_end != -1:
                        fm = yaml.safe_load(content[3:fm_end])
                        title = fm.get("title", title)
                        summary = fm.get("summary", "")
                recent_list.append(f"- {title}: {summary}")
            except: continue
        if recent_list:
            prompt = get_prompt("concept_clustering", ARTICLE_LIST="\n".join(recent_list))
            suggestions = call_llm_json(provider, prompt)
            if suggestions and suggestions.get("suggestions"):
                sugg_path = root / "wiki/concepts/_suggestions.md"
                sugg_text = "# Concept Suggestions\n\n"
                for s in suggestions["suggestions"]:
                    sugg_text += f"## {s['title']}\n- Rationale: {s['rationale']}\n- Link from: {', '.join(s['would_link_from'])}\n\n"
                sugg_path.write_text(sugg_text, encoding="utf-8")
        append_log(root, "compile", "scheduled pass")
        state_path = root / ".sage/state.json"
        state = {}
        if state_path.exists():
            try: state = json.loads(state_path.read_text(encoding="utf-8"))
            except: pass
        state["lastCompileAt"] = int(time.time())
        state_path.write_text(json.dumps(state), encoding="utf-8")
        send_event("log", level="info", message="Stitch pass completed")
    except Exception as e:
        logger.exception("Stitch pass failed")
        send_event("log", level="error", message=f"Stitch pass failed: {str(e)}")

def init_vault(vault_path: str, provider: str = "claude") -> None:
    try:
        root = Path(vault_path)
        dirs = ["wiki/notes", "wiki/papers", "wiki/web", "wiki/concepts", "wiki/people", "wiki/lists", "wiki/outputs", "wiki/clips", "source-cache", ".sage/staging", ".sage/tasks", ".sage/locks"]
        for d in dirs: (root / d).mkdir(parents=True, exist_ok=True)
        me_md = root / "wiki/people/me.md"
        if not me_md.exists():
            me_md.write_text("---\ntitle: Me\ntype: person\n---\n\nOwner of this vault.\n")
        config_path = root / ".sage/config.yaml"
        if not config_path.exists():
            config_path.parent.mkdir(parents=True, exist_ok=True)
            with open(config_path, "w") as f: yaml.dump({"llm_provider": provider}, f)
        update_index(root)
        send_event("log", level="info", message=f"Vault initialized at {vault_path}")
    except Exception as e:
        logger.exception("Failed to initialize vault")
        send_event("log", level="error", message=f"Failed to initialize vault: {str(e)}")

def main() -> None:
    logger.info("Worker starting...")
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            cmd_msg = json.loads(line)
            handle_command(cmd_msg)
        except json.JSONDecodeError:
            send_event("log", level="error", message=f"Failed to parse NDJSON: {line}")
        except Exception as e:
            logger.exception("Error handling command")
            send_event("log", level="error", message=str(e))

if __name__ == "__main__":
    main()

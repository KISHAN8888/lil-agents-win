import subprocess
import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional

from llm import find_binary

logger = logging.getLogger("worker.related")

def find_related(vault_path: Path, keywords: List[str], current_path: Optional[Path] = None) -> List[str]:
    """Finds related articles in the wiki using ripgrep."""
    if not keywords:
        return []

    rg_bin = find_binary("rg")
    wiki_dir = vault_path / "wiki"
    scores: Dict[str, int] = {}
    
    for kw in keywords:
        if not kw or len(kw) < 3:
            continue
            
        try:
            # rg --json -i -F <keyword> <wiki_dir>
            result = subprocess.run(
                [rg_bin, "--json", "-i", "-F", kw, str(wiki_dir)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdin=subprocess.DEVNULL
            )
            
            if result.returncode not in [0, 1]: # 0 = found, 1 = not found
                logger.error(f"ripgrep failed with code {result.returncode}: {result.stderr}")
                continue
                
            for line in result.stdout.splitlines():
                try:
                    data = json.loads(line)
                    if data.get("type") == "match":
                        path = data["data"]["path"]["text"]
                        # Normalize path
                        rel_path = str(Path(path).relative_to(vault_path)).replace("\\", "/")
                        
                        if current_path and Path(path) == current_path:
                            continue
                            
                        scores[rel_path] = scores.get(rel_path, 0) + 1
                except (json.JSONDecodeError, KeyError, ValueError):
                    continue
        except Exception as e:
            logger.error(f"Error running ripgrep for keyword '{kw}': {e}")

    # Sort by score desc, pick top 5
    sorted_related = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [path for path, score in sorted_related[:5]]

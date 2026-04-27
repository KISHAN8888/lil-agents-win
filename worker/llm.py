import subprocess
import json
import logging
import time
import os
import sys
import shutil
from pathlib import Path
from typing import Optional, Dict, Any

logger = logging.getLogger("worker.llm")

def find_binary(name: str) -> str:
    """Finds the binary for the given tool (claude, gemini, rg)."""
    # 1. Check if in PATH
    path = shutil.which(name)
    if path:
        return path
    
    # On Windows, try with .exe extension if not provided
    if sys.platform == "win32" and not name.lower().endswith(".exe"):
        path = shutil.which(name + ".exe")
        if path:
            return path

    home = Path.home()
    
    # 2. Check VS Code extension path (common for claude/rg)
    if name == "claude":
        ext_dir = home / ".vscode" / "extensions"
        if ext_dir.exists():
            matches = list(ext_dir.glob("anthropic.claude-code-*"))
            if matches:
                matches.sort(reverse=True)
                binary = matches[0] / "resources" / "native-binary" / "claude.exe"
                if binary.exists():
                    return str(binary)
                    
    if name == "rg" or name == "ripgrep":
        # Check bundled path
        if getattr(sys, 'frozen', False):
            # Running as compiled exe in resources/worker/
            base_dir = Path(sys.executable).parent.parent 
            bundled_rg = base_dir / "bin" / "rg.exe"
            if bundled_rg.exists():
                return str(bundled_rg)
        else:
            # Dev mode
            bundled_rg = Path(__file__).parent.parent / "resources" / "bin" / "rg.exe"
            if bundled_rg.exists():
                return str(bundled_rg)
            bundled_rg_alt = Path(__file__).parent.parent / "bin" / "rg.exe"
            if bundled_rg_alt.exists():
                return str(bundled_rg_alt)

        # Check VS Code's bundled ripgrep
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            # Typical path for VS Code User install
            rg_path = Path(local_app_data) / "Programs" / "Microsoft VS Code" / "resources" / "app" / "node_modules.asar.unpacked" / "@vscode" / "ripgrep" / "bin" / "rg.exe"
            if rg_path.exists():
                return str(rg_path)
    
    # 3. Fallback to just the name
    return name

def call_llm(provider: str, prompt: str, timeout: int = 60, retries: int = 1) -> Optional[str]:
    """Calls the specified LLM CLI with the given prompt."""
    
    binary_path = find_binary(provider)
    cmd = [binary_path, "-p", prompt]

    for attempt in range(retries + 1):
        try:
            logger.info(f"Calling {provider} (attempt {attempt + 1}) using {binary_path}...")
            # Use stdin=subprocess.DEVNULL to avoid Claude CLI waiting for stdin
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                encoding="utf-8",
                errors="replace",
                shell=False,
                stdin=subprocess.DEVNULL
            )
            
            if result.returncode == 0:
                return result.stdout.strip()
            else:
                logger.error(f"{provider} failed with exit code {result.returncode}: {result.stderr}")
        except subprocess.TimeoutExpired:
            logger.warning(f"{provider} timed out after {timeout}s")
        except FileNotFoundError:
            logger.error(f"Binary not found: {binary_path}")
            return None
        except Exception as e:
            logger.error(f"Error calling {provider}: {str(e)}")
        
        if attempt < retries:
            time.sleep(2)
            
    return None

def call_llm_json(provider: str, prompt: str, timeout: int = 60) -> Optional[Dict[str, Any]]:
    """Calls LLM and attempts to parse JSON from the response."""
    response = call_llm(provider, prompt, timeout)
    if not response:
        return None
    
    try:
        start = response.find('{')
        end = response.rfind('}')
        if start != -1 and end != -1:
            json_str = response[start:end+1]
            return json.loads(json_str)
        return json.loads(response)
    except json.JSONDecodeError:
        logger.error(f"Failed to parse JSON from {provider} response: {response}")
        return None

"""Render the Chrome Web Store listing images.

    python tools/make-store-shots.py

Writes 1280x800 PNGs (the size the store accepts) into assets/store/, plus a
2560x1600 @2x of each for a landing page or press kit. Every shot is rendered at
twice the target size and resampled down, which is the whole point: the board
inside the frame is real extension markup at roughly half scale, and rasterising
8px type at 1x is what made the earlier artwork look soft.

Chrome does the rendering, Pillow the resampling. Set CHROME to point at a
Chrome or Chromium the script cannot find by itself.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "assets" / "store"
W, H = 1280, 800

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

# --- shared board content ---------------------------------------------------
# One believable board, reused across the shots so the listing reads as one
# product rather than five unrelated screenshots.

TABS = [
    ("Supabase", "supabase.com", True),
    ("Claude", "claude.ai", False),
    ("Explain PCA Simply", "chatgpt.com", False),
    ("Explain Machine Learning", "chatgpt.com", False),
    ("Chrome Developer Account", "chatgpt.com", True),
    ("Inbox (427) - toadsadobe", "mail.google.com", False),
    ("(50) WhatsApp", "web.whatsapp.com", False),
    ("Projects - Home", "dev.azure.com", True),
    ("Extensions", "extensions", False),
    ("Tabme - Tab & Bookmark", "chromewebstore.google.com", False),
    ("Vercel Dashboard", "vercel.com", True),
    ("Figma - Brand kit", "figma.com", False),
    ("Linear - Sprint 14", "linear.app", True),
    ("Stack Overflow", "stackoverflow.com", False),
    ("MDN Web Docs", "developer.mozilla.org", False),
]

FOLDERS = [
    {"title": "Notion", "color": "#FDE293", "items": [
        "queensjournal", {"title": "Push Notifications - Wallycon", "open": True},
        "GSA Cooked", "Dashboard | Wallycon", "Roadmap Q3", "Meeting notes"]},
    {"title": "Esso", "color": "#F9D8E4", "items": [
        "ChatGPT Pro", "ChatGPT Verification Codes", "YouTube",
        {"title": "Canva", "open": True}, "Cursor pro", "Figma - Brand kit",
        "Linear - Sprint 14"]},
    {"title": "bugging repo's", "color": "#FEDAD1", "items": [
        "coffinxp/wayback-url-finder", "zakirkun/deep-eye", "intruder-io/autoswagger",
        "(39) WhatsApp", "projectdiscovery/nuclei"]},
    {"title": "VIBE coder", "color": "#D7E3B4", "items": [
        "Orchids", "v0", "Chat with Z.ai", {"title": "Lovable", "open": True},
        "Bolt.new", "Replit Agent"]},
    {"title": "AI's", "color": "#C4EED0", "items": [
        "Perplexity", "K2 Think - MBZUAI", "NotebookLM", "Elicit", "Claude",
        "Gemini", "Mistral Le Chat"]},
    {"title": "CTF", "color": "#F8AFA0", "items": [
        "BruteForce", "Base64 decode", "CTF calendar", "CyberChef",
        "HackTheBox - Active", "picoCTF"]},
    {"title": "Cooking", "color": "#E9DDFF", "items": [
        "PentestGPT", "DeepHat", "WhiteRabbitNeo", "Aperi'Solve - Steganography",
        "Transform - Cryptex"]},
    {"title": "Reading", "color": "#D3E3FD", "items": [
        "The Pragmatic Engineer", "Simon Willison's Weblog",
        {"title": "Hacker News", "open": True}, "Ink & Switch", "Julia Evans"]},
]

TAGS = [{"name": "important", "count": 24, "active": True},
        {"name": "reading", "count": 18},
        {"name": "research", "count": 16},
        {"name": "work", "count": 14}]


def board(**over):
    base = {
        "tabs": [{"title": t, "host": h, "saved": s} for t, h, s in TABS],
        "folders": FOLDERS,
        "spaces": ["Wild Space", "Notes"],
        "activeSpace": 0,
        "columns": 3,
        "tags": [],
        "notes": [],
    }
    base.update(over)
    return base


LIGHT_DECO = [
    {"style": {"left": "-120px", "top": "-90px", "width": "420px", "height": "420px"}},
    {"style": {"right": "-60px", "bottom": "120px", "width": "300px", "height": "300px"}},
    {"dots": True, "style": {"left": "0", "bottom": "40px", "width": "150px", "height": "150px"}},
]
DARK_DECO = [
    {"style": {"left": "-100px", "top": "40px", "width": "520px", "height": "520px"}},
    {"style": {"right": "80px", "bottom": "-120px", "width": "460px", "height": "460px"}},
]

# --- the five shots ---------------------------------------------------------

SHOTS = [
    {
        "name": "01-organize",
        "theme": "light",
        "headline": "Your Tabs,<br><em>Finally</em><br>Organized.",
        "sub": "Drag a tab out of the sidebar and it is filed.<br>Tag it, search it, find it in a second.<br>Your browser can be calm about this.",
        "deco": LIGHT_DECO,
        "macBar": True,
        "frame": {"left": "428px", "top": "14px", "width": "852px", "height": "652px"},
        "board": board(columns=3, notes=[{"text": "Your notes here \u2014 quick thoughts, ideas, reminders.",
                               "x": 486, "y": 452, "color": "#E4C8FF"}]),
        "chips": [
            {"title": "Drag to File", "desc": "Sidebar to folder. That is the whole trick.",
             "icon": "folder", "bg": "#ebf6fd", "iconBg": "#cfe6fb", "fg": "#1668b0"},
            {"title": "Tag Everything", "desc": "One tag pulls back everything related.",
             "icon": "tag", "bg": "#eefaf1", "iconBg": "#cdefd8", "fg": "#16794a"},
            {"title": "Find It Fast", "desc": "Title, URL, folder or tag. All of it.",
             "icon": "search", "bg": "#f3f2fc", "iconBg": "#ddd9f8", "fg": "#5342b8"},
            {"title": "Follows You", "desc": "Same board on every browser you sign in to.",
             "icon": "cloud", "bg": "#fdf6e8", "iconBg": "#fae4bb", "fg": "#96631a"},
        ],
    },
    {
        "name": "02-tags",
        "theme": "dark",
        "headlineSize": "48px",
        "headline": "<em>Tag</em> It Once.<br>Find It <em>Forever.</em>",
        "sub": "Tag a bookmark, a folder, anything.<br>One tap pulls back everything related \u2014<br>however many tags you make.",
        "deco": DARK_DECO,
        "macBar": False,
        "frame": {"left": "412px", "top": "46px", "width": "868px", "height": "708px"},
        "board": board(tags=TAGS, columns=3,
                       notes=[{"text": "Tag once. Everything related shows up together.",
                               "x": 118, "y": 524, "color": "#C9D4FF"}]),
        "feats": [
            {"title": "Your Tags, Your Words", "desc": "Name them whatever makes sense to you.",
             "icon": "tag", "bg": "rgba(70,107,252,.16)", "fg": "#6d90ff"},
            {"title": "Instant Search", "desc": "Type two letters. There it is.",
             "icon": "search", "bg": "rgba(45,200,120,.16)", "fg": "#3ddc8a"},
            {"title": "Less Noise", "desc": "Your board stays clean. Your browser, less so.",
             "icon": "folder", "bg": "rgba(240,180,41,.16)", "fg": "#f0b429"},
        ],
        "callout": {
            "style": {"right": "20px", "top": "96px", "width": "262px"},
            "title": "Tags",
            "rows": [
                {"name": "Important", "count": 24, "color": "#f2545b"},
                {"name": "Reading", "count": 18, "color": "#4d8df6"},
                {"name": "Research", "count": 16, "color": "#a26bf5"},
                {"name": "Work", "count": 14, "color": "#f0b429"},
                {"name": "Design", "count": 12, "color": "#f26fb0"},
                {"name": "Dev", "count": 10, "color": "#3ddc8a"},
                {"name": "Learning", "count": 9, "color": "#2fc4c9"},
                {"name": "Shopping", "count": 7, "color": "#f08c29"},
            ],
            "note": {"title": "One tag. Many results.",
                     "desc": "Find everything related in seconds."},
        },
    },
    {
        "name": "03-stash",
        "theme": "light",
        "headline": "Stash the Lot.<br><em>One Click.</em><br>Zero Losses.",
        "sub": "Every open tab into a folder, in one go.<br>"
               "Sort them, kill the duplicates, close the lot \u2014<br>"
               "and lose absolutely none of them.",
        "deco": LIGHT_DECO,
        "macBar": True,
        "frame": {"left": "428px", "top": "14px", "width": "852px", "height": "652px"},
        "board": board(columns=3),
        "chips": [
            {"title": "Stash All", "desc": "Every open tab into one folder, instantly.",
             "icon": "layers", "bg": "#ebf6fd", "iconBg": "#cfe6fb", "fg": "#1668b0"},
            {"title": "Sort", "desc": "By title, by site, or by what you touched last.",
             "icon": "sort", "bg": "#eefaf1", "iconBg": "#cdefd8", "fg": "#16794a"},
            {"title": "Dedupe", "desc": "Close every duplicate tab in one go.",
             "icon": "copy", "bg": "#f3f2fc", "iconBg": "#ddd9f8", "fg": "#5342b8"},
            {"title": "See What's Open", "desc": "Live tabs glow in the board. Close from there.",
             "icon": "bolt", "bg": "#fdf6e8", "iconBg": "#fae4bb", "fg": "#96631a"},
        ],
    },
    {
        "name": "04-spaces",
        "theme": "dark",
        "headlineSize": "44px",
        "headline": "Work Stays Work.<br><em>Weekend Stays</em><br><em>Weekend.</em>",
        "sub": "Work, side project, the holiday you keep<br>"
               "researching \u2014 each one gets its own board.<br>"
               "Switch between them in a click.",
        "deco": DARK_DECO,
        "macBar": False,
        "frame": {"left": "412px", "top": "46px", "width": "868px", "height": "708px"},
        "board": board(spaces=["Work", "Personal", "Research", "CTF"],
                       activeSpace=2, columns=3,
                       notes=[{"text": "Each space keeps its own folders, tags and notes.",
                               "x": 118, "y": 524, "color": "#B5EFD0"}]),
        "feats": [
            {"title": "Unlimited Spaces", "desc": "As many boards as you have lives. No cap, ever.",
             "icon": "grid", "bg": "rgba(70,107,252,.16)", "fg": "#6d90ff"},
            {"title": "Nothing Bleeds Across", "desc": "Each space keeps its own folders and notes.",
             "icon": "layers", "bg": "rgba(45,200,120,.16)", "fg": "#3ddc8a"},
            {"title": "Notes On The Board", "desc": "Stick a thought anywhere. It stays put.",
             "icon": "note", "bg": "rgba(240,180,41,.16)", "fg": "#f0b429"},
        ],
        "callout": {
            "style": {"right": "22px", "top": "150px", "width": "250px"},
            "title": "Spaces",
            "rows": [
                {"name": "Work", "count": 34, "color": "#4d8df6"},
                {"name": "Personal", "count": 21, "color": "#3ddc8a"},
                {"name": "Research", "count": 55, "color": "#a26bf5"},
                {"name": "CTF", "count": 18, "color": "#f2545b"},
            ],
            "note": {"title": "Switch in one click.",
                     "desc": "Your work board never sees your weekend."},
        },
    },
    {
        "name": "05-sync",
        "theme": "light",
        "headline": "Close the Laptop.<br><em>Nothing's Lost.</em>",
        "sub": "Sign in once and your board follows you<br>"
               "to every browser you use. Or keep it all<br>"
               "on this machine \u2014 that switch is yours.",
        "deco": LIGHT_DECO,
        "macBar": True,
        "frame": {"left": "428px", "top": "14px", "width": "852px", "height": "652px"},
        "board": board(columns=3,
                       notes=[{"text": "Synced from my laptop 2 minutes ago.",
                               "x": 486, "y": 452, "color": "#B8E6FF"}]),
        "chips": [
            {"title": "Every Device", "desc": "Sign in and your board is already there.",
             "icon": "cloud", "bg": "#ebf6fd", "iconBg": "#cfe6fb", "fg": "#1668b0"},
            {"title": "Or Stay Local", "desc": "Turn sync off and nothing leaves the machine.",
             "icon": "check", "bg": "#eefaf1", "iconBg": "#cdefd8", "fg": "#16794a"},
            {"title": "Import Bookmarks", "desc": "Bring the folders you already had.",
             "icon": "folder", "bg": "#f3f2fc", "iconBg": "#ddd9f8", "fg": "#5342b8"},
            {"title": "Export Anytime", "desc": "One file. Your board is never held hostage.",
             "icon": "copy", "bg": "#fdf6e8", "iconBg": "#fae4bb", "fg": "#96631a"},
        ],
    },
]


def find_chrome():
    for path in CHROME_CANDIDATES:
        if path and Path(path).exists():
            return path
    print("No Chrome found. Set CHROME to a Chrome or Chromium binary.")
    sys.exit(1)


def main():
    chrome = find_chrome()
    STORE.mkdir(parents=True, exist_ok=True)
    template = (STORE / "shot.html").read_text(encoding="utf-8")
    work = Path(tempfile.mkdtemp(prefix="tabspace-store-"))

    try:
        for shot in SHOTS:
            page = STORE / f".build-{shot['name']}.html"
            page.write_text(
                template.replace("SHOT_CONFIG", json.dumps(shot)), encoding="utf-8")

            big = work / f"{shot['name']}@2x.png"
            subprocess.run([
                chrome, "--headless", "--disable-gpu", "--hide-scrollbars",
                "--force-device-scale-factor=2",
                f"--window-size={W},{H}",
                f"--screenshot={big}",
                "--virtual-time-budget=4000",
                page.as_uri(),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            page.unlink()

            if not big.exists():
                print(f"  Chrome produced nothing for {shot['name']}")
                sys.exit(1)

            im = Image.open(big).convert("RGB")
            im.save(STORE / f"{shot['name']}@2x.png")
            im.resize((W, H), Image.LANCZOS).save(STORE / f"{shot['name']}.png")
            print(f"  assets/store/{shot['name']}.png      {W}x{H}   (+ @2x at {im.width}x{im.height})")

        print("\nUpload the five 1280x800 files as the listing screenshots.")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

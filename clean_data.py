#!/usr/bin/env python3
"""
Clean personal identifying information from scraped eVision JSON files.

Removes:
  - Entire "Students" content sections (contain student IDs)
  - Module header sections (keys matching "CODE - DEPT - TITLE", contain staff names)
  - Staff/lecturer names from any remaining text
  - Student IDs (100XXXXXX/X patterns)
  - Email addresses
  - "Email me..." and "Click here to create..." boilerplate text
  - Known personal identifiers (student username, name)
"""

import json
import re
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

# Patterns to remove
STUDENT_ID_PATTERN = re.compile(r':?\s*\d{9}/\d')
EMAIL_PATTERN = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}')
KNOWN_PERSONAL = [
    re.compile(r'mcu22seu', re.IGNORECASE),
    re.compile(r'Christopher Birkbeck', re.IGNORECASE),
    re.compile(r'BIRKBECK,?\s*CHRIS\w*', re.IGNORECASE),
]

# Module header key pattern: "CODE - DEPT - TITLE" e.g. "MTHA4003B - MTH - REAL ANALYSIS"
# Also matches hyphenated codes like "CMP-5015A - CMP - PROGRAMMING 2"
MODULE_HEADER_KEY = re.compile(r'^[A-Z]{3,5}-?\d{4}[A-Z]?\s*-\s*[A-Z]{2,4}\s*-\s*.+$')

# Boilerplate text to strip from descriptions
BOILERPLATE = [
    re.compile(r'Additional Module Details\s*\n?\s*Email me the additional details\.?', re.IGNORECASE),
    re.compile(r'Email me the additional details\.?', re.IGNORECASE),
    re.compile(r'Email me exported data updated!!!.*$', re.IGNORECASE | re.DOTALL),
    re.compile(r'Click here to create an email to students on this module\.?', re.IGNORECASE),
    re.compile(r'Total Enrolled Students:\s*\d+', re.IGNORECASE),
    re.compile(r'Logged In:.*?(?:Logout\)|$)', re.IGNORECASE),
    re.compile(r'Pick an account.*?Signed in', re.DOTALL),
]


def clean_text(text):
    """Strip PII and boilerplate from a text string."""
    if not isinstance(text, str):
        return text

    # Remove student IDs
    text = STUDENT_ID_PATTERN.sub('', text)

    # Remove emails
    text = EMAIL_PATTERN.sub('', text)

    # Remove known personal data
    for p in KNOWN_PERSONAL:
        text = p.sub('', text)

    # Remove boilerplate
    for p in BOILERPLATE:
        text = p.sub('', text)

    # Clean up resulting whitespace
    text = re.sub(r'\n\s*\n\s*\n+', '\n\n', text)
    return text.strip()


def clean_module(mod):
    """Clean a single module dict in place."""
    cs = mod.get('content_sections', {})
    keys_to_remove = []

    for key in cs:
        # Remove "Students" sections entirely
        if key == 'Students':
            keys_to_remove.append(key)
            continue

        # Remove module header sections (contain staff names, duplicate data)
        if MODULE_HEADER_KEY.match(key):
            keys_to_remove.append(key)
            continue

        # Keep "Module Assessment Pattern" for students

        # Clean remaining section text
        cs[key] = clean_text(cs[key])

        # Remove section if it became empty
        if not cs[key]:
            keys_to_remove.append(key)

    for key in keys_to_remove:
        del cs[key]

    # Clean top-level string fields
    for field in ['description', 'notes', 'module_rules', 'table_info']:
        if field in mod and isinstance(mod[field], str):
            mod[field] = clean_text(mod[field])

    # Remove full_detail_text if present
    mod.pop('full_detail_text', None)


def clean_file(path):
    """Clean a per-year JSON file in place."""
    with open(path) as f:
        data = json.load(f)

    modules = data.get('modules', [])
    for mod in modules:
        clean_module(mod)

    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    return len(modules)


def main():
    # Find all per-year JSON files
    year_files = sorted(DATA_DIR.glob('uea_modules_20*_*.json'))
    year_files = [f for f in year_files if 'combined' not in f.name]

    if not year_files:
        print("No per-year data files found.")
        return

    print(f"Cleaning {len(year_files)} file(s):")
    for path in year_files:
        count = clean_file(path)
        print(f"  {path.name}: cleaned {count} modules")

    # Also clean the combined file if it exists
    combined = DATA_DIR / 'uea_modules_combined.json'
    if combined.exists():
        count = clean_file(combined)
        print(f"  {combined.name}: cleaned {count} modules")

    print("\nDone! PII has been removed.")
    print("You may want to run rebuild_combined.py to regenerate the combined file from clean sources.")


if __name__ == '__main__':
    main()

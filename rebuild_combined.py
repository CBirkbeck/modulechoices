#!/usr/bin/env python3
"""
Rebuild uea_modules_combined.json from per-year scraped data.

Each per-year file (e.g. uea_modules_2025_6.json) contains the modules
that RUN in that calendar academic year. A module's available_years lists
every calendar year it appears in.

For entry-year filtering the app computes:
  Year N of study  →  entry_start + (N-1)  →  calendar academic year
and shows modules whose available_years includes that calendar year.

For calendar years beyond our data we infer from the 2-year alternating
cycle (e.g. 2027/8 ≡ 2025/6).
"""

import json
import re
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

# Personal data patterns to strip
PERSONAL_PATTERNS = [
    re.compile(r'Logged In:.*?(?:Logout\)|\n)', re.IGNORECASE),
    re.compile(r'Pick an account.*?Signed in', re.DOTALL),
    re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}'),
    re.compile(r'\d{9}/\d'),
    re.compile(r'mcu22seu', re.IGNORECASE),
    re.compile(r'Christopher Birkbeck', re.IGNORECASE),
    re.compile(r'BIRKBECK,?\s*CHRIS\w*', re.IGNORECASE),
]


def strip_personal(text):
    if not isinstance(text, str):
        return text
    for p in PERSONAL_PATTERNS:
        text = p.sub('', text)
    return text


def clean_table_info(ti):
    if not ti:
        return ''
    parts = [p.strip() for p in ti.split(' | ')]
    clean = []
    for part in parts:
        if re.match(r'^\s*:?\s*Code:', part) or re.match(r'^\s*:?\s*\d{6,}', part):
            break
        if 'Module Organiser' in part or 'Actual (Target)' in part or re.match(r'^Seq:', part):
            continue
        clean.append(part)
    return ' | '.join(clean)


def load_year_file(path):
    """Load a per-year JSON and clean it."""
    with open(path) as f:
        data = json.load(f)

    year_label = data.get('academic_year', '')
    modules = data.get('modules', [])

    # Clean personal data
    for mod in modules:
        mod.pop('full_detail_text', None)
        if 'table_info' in mod:
            mod['table_info'] = strip_personal(clean_table_info(mod['table_info']))
        for k in list(mod.keys()):
            mod[k] = strip_personal(mod[k])

    return year_label, modules


def main():
    # Discover all year files
    year_files = sorted(DATA_DIR.glob('uea_modules_20*_*.json'))
    year_files = [f for f in year_files if 'combined' not in f.name]

    if not year_files:
        print("No per-year data files found in data/")
        return

    print(f"Found {len(year_files)} year file(s):")

    # Load all years
    # Key by (module_code, year_of_study) since a module can appear
    # under multiple study years (e.g. Year 2U Range A AND Year 3U Range C)
    all_years = {}  # year_label -> {(code, study_year) -> module_data}
    for path in year_files:
        year_label, modules = load_year_file(path)
        print(f"  {path.name}: {year_label} — {len(modules)} modules")
        code_map = {}
        for mod in modules:
            code_map[(mod['module_code'], mod['year'])] = mod
        all_years[year_label] = code_map

    year_labels = sorted(all_years.keys())
    print(f"\nCalendar years in data: {year_labels}")

    # Build combined: for each unique (code, year-of-study) pair,
    # take the most recent year's version and track all available_years.
    # Also track per-year module_rules so the app can show the right rules
    # for each entry year (rules may change between academic years).
    # Key = (module_code, year_of_study)
    combined_map = {}
    rules_tracker = {}  # key -> {year_label: module_rules}

    for year_label in year_labels:
        for (code, study_year), mod in all_years[year_label].items():
            key = (code, study_year)
            if key not in combined_map:
                combined_map[key] = {**mod, 'available_years': [], 'content_sections': {}}
                rules_tracker[key] = {}
            # Always update to the latest version of module data
            # (rules, credits etc. may change), but keep available_years and
            # merge content_sections (keep any descriptions we've collected)
            avail = combined_map[key]['available_years']
            existing_content = combined_map[key].get('content_sections', {})
            new_content = mod.get('content_sections', {})
            merged_content = {**existing_content, **new_content}
            combined_map[key] = {**mod, 'available_years': avail, 'content_sections': merged_content}
            if year_label not in avail:
                avail.append(year_label)

            # Track per-year rules
            rules_tracker[key][year_label] = mod.get('module_rules', '')

    # Add rules_by_year when rules differ across years
    for key, rules_map in rules_tracker.items():
        unique_rules = set()
        for r in rules_map.values():
            # Normalize for comparison: convert list to tuple
            unique_rules.add(json.dumps(r, sort_keys=True) if isinstance(r, list) else r)
        if len(unique_rules) > 1:
            combined_map[key]['rules_by_year'] = rules_map

    # Sort combined modules by year, section order, then code
    section_order = {
        'Compulsory Modules': 0, 'Core Modules': 0,
        'Options Range A': 1, 'Options Range B': 2, 'Options Range C': 3,
    }

    def sort_key(m):
        year_num = int(re.search(r'\d', m['year']).group())
        sec = m['section']
        sec_idx = 99
        for prefix, idx in section_order.items():
            if sec.startswith(prefix):
                sec_idx = idx
                break
        return (year_num, sec_idx, m['module_code'])

    combined = sorted(combined_map.values(), key=sort_key)

    # Write combined file
    out_path = DATA_DIR / 'uea_modules_combined.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({
            'course': 'MASTER OF MATHEMATICS (U1G103402)',
            'school': 'ENGINEERING, MATHEMATICS AND PHYSICS',
            'academic_years': year_labels,
            'modules': combined,
        }, f, indent=2, ensure_ascii=False)

    print(f"\nCombined: {len(combined)} unique (code, year-of-study) entries")
    print(f"Written to: {out_path}")

    # Summary per year of study
    for y in ['Year 1U', 'Year 2U', 'Year 3U', 'Year 4U']:
        mods = [m for m in combined if m['year'] == y]
        avail_counts = {}
        for m in mods:
            for ay in m['available_years']:
                avail_counts[ay] = avail_counts.get(ay, 0) + 1
        print(f"  {y}: {len(mods)} modules — availability: {avail_counts}")


if __name__ == '__main__':
    main()

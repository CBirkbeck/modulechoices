#!/usr/bin/env python3
"""
eVision Module Scraper for UEA - Master of Mathematics
Uses Playwright to automate browser, letting user log in manually.
Scrapes module details including prerequisites from linked pages.
Outputs CSV and JSON.
"""

import json
import csv
import re
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

OUTPUT_DIR = Path(__file__).parent / "data"
EVISION_BASE = "https://evision.uea.ac.uk"


def parse_course_page(page):
    """Parse the main course profile page for all modules."""
    modules = []

    # Get all year sections
    years = page.query_selector_all("h2")

    for year_el in years:
        year_text = year_el.inner_text().strip()
        if not year_text.startswith("Year"):
            continue

        # Walk through siblings to find sections and tables
        sibling = year_el.evaluate_handle("el => el.nextElementSibling")

    # Alternative approach: parse the structured HTML directly
    # Get the full HTML and parse section by section
    html = page.content()

    # Use the page's DOM to extract structured data
    sections = page.evaluate("""() => {
        const results = [];
        let currentYear = '';
        let currentSection = '';
        let currentCreditRule = '';
        let currentNotes = '';

        // Walk through all relevant elements in order
        const elements = document.querySelectorAll('h2, h3, h4, p, table.sv-table');

        for (const el of elements) {
            if (el.tagName === 'H2') {
                currentYear = el.textContent.trim();
                currentSection = '';
                currentCreditRule = '';
                currentNotes = '';
            }
            else if (el.tagName === 'H4') {
                currentSection = el.textContent.trim();
                currentCreditRule = '';
                currentNotes = '';
            }
            else if (el.tagName === 'P') {
                const text = el.textContent.trim();
                if (text) {
                    // Extract credit selection rules
                    const creditMatch = text.match(/Students will select (\\d+-\\d+) credits/);
                    if (creditMatch) {
                        currentCreditRule = creditMatch[1] + ' credits';
                    }
                    // Capture any additional notes/rules
                    currentNotes = text.replace(/\\s+/g, ' ').trim();
                }
            }
            else if (el.tagName === 'TABLE') {
                const rows = el.querySelectorAll('tbody tr');
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 6) {
                        const moduleCell = cells[0];
                        const link = moduleCell.querySelector('a.sv-hidden-print');
                        const moduleCode = link ? link.textContent.trim() :
                            moduleCell.querySelector('.sv-visible-print-inline')?.textContent.trim() || '';
                        const moduleUrl = link ? link.href : '';

                        results.push({
                            year: currentYear,
                            section: currentSection,
                            credit_rule: currentCreditRule,
                            notes: currentNotes,
                            module_code: moduleCode,
                            description: cells[1].querySelector('.tablesaw-cell-content')?.textContent.trim() || '',
                            assessment: cells[2].querySelector('.tablesaw-cell-content')?.textContent.trim() || '',
                            credits: cells[3].querySelector('.tablesaw-cell-content')?.textContent.trim() || '',
                            period: cells[4].querySelector('.tablesaw-cell-content')?.textContent.trim() || '',
                            sub_slot: cells[5].querySelector('.tablesaw-cell-content')?.textContent.trim() || '',
                            url: moduleUrl
                        });
                    }
                }
            }
        }
        return results;
    }""")

    return sections


def scrape_module_detail_from_page(detail_page, module_code):
    """Scrape module info from an already-loaded detail page."""
    detail = {
        "prerequisites": "",
        "module_rules": "",
        "full_text": ""
    }

    try:
        detail_data = detail_page.evaluate("""() => {
            const data = {};

            // Find "Module Rules" table - contains prerequisites
            const tables = document.querySelectorAll('table.sv-table');
            for (const table of tables) {
                const caption = table.querySelector('caption');
                if (caption && caption.textContent.trim() === 'Module Rules') {
                    const td = table.querySelector('tbody td');
                    if (td) {
                        data.module_rules = td.textContent.trim();
                    }
                }
            }

            // Extract prerequisite module codes from the rules text
            if (data.module_rules) {
                const codes = data.module_rules.match(/[A-Z]{3,4}[A-Z0-9]?[-_]?\\d{4}[A-Z]?/g);
                data.prerequisite_codes = codes || [];
            }

            // Get assessment info from the first table (module overview)
            const firstTable = tables[0];
            if (firstTable) {
                const rows = firstTable.querySelectorAll('tr');
                const info = {};
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        const key = cells[0].textContent.trim().replace(':', '');
                        const val = cells[1].textContent.trim();
                        // Skip student-related fields
                        if (!['Code', 'Surname', 'Forename', 'Email', 'Status'].includes(key)) {
                            info[key] = val;
                        }
                    }
                }
                data.module_info = info;
            }

            return data;
        }""")

        detail["module_rules"] = detail_data.get("module_rules", "")
        detail["prerequisite_codes"] = detail_data.get("prerequisite_codes", [])
        detail["module_info"] = detail_data.get("module_info", {})

    except PlaywrightTimeout:
        print(f"    Timeout loading {module_code}")
    except Exception as e:
        print(f"    Error scraping detail for {module_code}: {e}")

    return detail


def main():
    print("=" * 60)
    print("UEA eVision Module Scraper")
    print("=" * 60)
    print()
    print("A browser window will open. Please:")
    print("  1. Log in to eVision")
    print("  2. Navigate to the Course Profile page")
    print("  3. Press ENTER in this terminal when the page is loaded")
    print()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()

        # Navigate to eVision main page
        page.goto(EVISION_BASE, wait_until="domcontentloaded")

        print("IMPORTANT: Do everything inside the Chromium browser that just opened.")
        print("  - Click 'Staff Log In' (it's OK if it opens a new tab)")
        print("  - Log in with your UEA credentials")
        print("  - Navigate to the Course Profile page")
        print("  - Then come back here and press ENTER")
        print()
        input(">>> Press ENTER once the Course Profile page is loaded... ")

        # Find the Course Profile page among all open tabs
        all_pages = context.pages
        page = None
        print(f"\nFound {len(all_pages)} open tab(s):")
        for i, p_tab in enumerate(all_pages):
            try:
                title = p_tab.title()
                url = p_tab.url[:80]
                print(f"  Tab {i}: {title} — {url}")
                if "Course Profile" in title or "YGSL" in p_tab.url:
                    page = p_tab
            except Exception:
                print(f"  Tab {i}: (closed or inaccessible)")

        if page is None:
            # Fall back to the last open tab
            for p_tab in reversed(all_pages):
                try:
                    _ = p_tab.title()
                    page = p_tab
                    break
                except Exception:
                    continue

        if page is None:
            print("Error: No accessible browser tabs found!")
            browser.close()
            return

        print(f"\nUsing: {page.title()} — {page.url[:80]}")
        page.wait_for_timeout(2000)

        # Detect the academic year from the page
        academic_year = page.evaluate("""() => {
            const h1 = document.querySelector('h1');
            if (h1) {
                const match = h1.textContent.match(/(\\d{4}\\/\\d)/);
                if (match) return match[1];
            }
            return '';
        }""") or input("Could not detect academic year. Enter it (e.g. 2025/6): ").strip()
        print(f"  Academic year: {academic_year}")

        print("Scraping course overview...")
        modules = parse_course_page(page)
        print(f"  Found {len(modules)} modules on the course profile page.")

        if not modules:
            print("No modules found! Make sure you're on the correct page.")
            browser.close()
            return

        # Now visit each module's detail page by clicking links in the same tab
        total = len(modules)
        for i, mod in enumerate(modules):
            code = mod["module_code"]
            print(f"  [{i+1}/{total}] Scraping details for {code}: {mod['description']}...")

            try:
                # Find and click the module link on the current page
                link = page.query_selector(f'a.sv-hidden-print:has-text("{code}")')
                if link:
                    link.click()
                    page.wait_for_load_state("domcontentloaded", timeout=15000)
                    page.wait_for_timeout(1500)

                    detail = scrape_module_detail_from_page(page, code)
                    mod["module_rules"] = detail.get("module_rules", "")
                    mod["prerequisite_codes"] = detail.get("prerequisite_codes", [])
                    if detail.get("module_rules"):
                        print(f"    Rules: {detail['module_rules'][:100]}")

                    # Go back to course profile
                    page.go_back(wait_until="domcontentloaded", timeout=15000)
                    page.wait_for_timeout(1000)
                else:
                    print(f"    Link not found for {code}, skipping detail")
            except Exception as e:
                print(f"    Error scraping {code}: {e}")
            if "module_rules" not in mod:
                mod["module_rules"] = ""
                mod["prerequisite_codes"] = []

        browser.close()

    # Strip personal information (student/staff names, emails, login info)
    personal_patterns = [
        re.compile(r'Logged In:.*?(?:Logout\)|\n)', re.IGNORECASE),
        re.compile(r'Pick an account.*?Signed in', re.DOTALL),
        re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}'),
        re.compile(r'(?:DR|PROF|MR|MRS|MS|MISS)\s+[A-Z][a-z]+\s+[A-Z][a-z]+', re.IGNORECASE),
        re.compile(r'mcu22seu', re.IGNORECASE),
        re.compile(r'Christopher Birkbeck', re.IGNORECASE),
        re.compile(r'BIRKBECK,?\s*CHRIS\w*', re.IGNORECASE),
    ]

    def strip_personal(text):
        if not isinstance(text, str):
            return text
        for pattern in personal_patterns:
            text = pattern.sub('[REDACTED]', text)
        return text

    for mod in modules:
        for key in mod:
            mod[key] = strip_personal(mod[key])

    csv_fields = [
        "year", "section", "credit_rule", "notes",
        "module_code", "description", "assessment", "credits",
        "period", "sub_slot", "module_rules"
    ]

    # Use academic year in filenames (e.g. "2025_6")
    year_slug = academic_year.replace("/", "_")

    # Also strip student enrollment data from table_info
    for mod in modules:
        ti = mod.get("table_info", "")
        if ti:
            parts = [p.strip() for p in ti.split(" | ")]
            clean = []
            for part in parts:
                # Stop at student data
                if re.match(r'^\s*:?\s*Code:', part) or re.match(r'^\s*:?\s*\d{6,}', part):
                    break
                if 'Module Organiser' in part or 'Actual (Target)' in part:
                    continue
                if re.match(r'^Seq:', part):
                    continue
                clean.append(part)
            mod["table_info"] = " | ".join(clean)

    # Save CSV
    csv_path = OUTPUT_DIR / f"uea_modules_{year_slug}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=csv_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(modules)
    print(f"\nCSV saved to: {csv_path}")

    # Save JSON
    json_path = OUTPUT_DIR / f"uea_modules_{year_slug}.json"
    json_modules = []
    for mod in modules:
        m = {k: v for k, v in mod.items() if k not in ("url", "full_detail_text")}
        # Ensure prerequisite_codes is always a list
        if "prerequisite_codes" not in m:
            m["prerequisite_codes"] = []
        json_modules.append(m)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "course": "MASTER OF MATHEMATICS (U1G103402)",
            "academic_year": academic_year,
            "school": "ENGINEERING, MATHEMATICS AND PHYSICS",
            "scraped_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "modules": json_modules
        }, f, indent=2, ensure_ascii=False)
    print(f"JSON saved to: {json_path}")

    # Print summary
    print(f"\n{'=' * 60}")
    print(f"SUMMARY")
    print(f"{'=' * 60}")
    years = set(m["year"] for m in modules)
    for year in sorted(years):
        year_mods = [m for m in modules if m["year"] == year]
        print(f"\n{year}:")
        sections = []
        seen = set()
        for m in year_mods:
            key = (m["section"], m["credit_rule"])
            if key not in seen:
                seen.add(key)
                count = sum(1 for x in year_mods if x["section"] == m["section"])
                rule = f" ({m['credit_rule']})" if m["credit_rule"] else ""
                sections.append(f"  {m['section']}{rule}: {count} modules")
        for s in sections:
            print(s)

    print(f"\nTotal modules: {len(modules)}")
    print("Done!")


if __name__ == "__main__":
    main()

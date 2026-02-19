/* ===================================================================
   UEA MMath Module Catalogue – app.js
   Single-page interactive module browser with dependency visualisation
   =================================================================== */

(function () {
  'use strict';

  // ===== STATE =====
  const STATE = {
    entryYear: '2025/6',
    activeModule: null,     // uid of currently clicked module
    selectedModules: new Set(), // set of uids
    searchQuery: '',
    periodFilter: 'all',
    showDetails: false,
    darkMode: false,
    modules: [],
    moduleIndex: new Map(),   // uid -> enriched module (uid = "CODE|Year XU")
    codeEntries: new Map(),   // plain code -> [enriched modules] (for dependency lookups)
    ghostModules: new Set(),
    visibleSections: [],
    dataYears: [],
  };

  const STORAGE_KEY = 'uea-mmath-catalogue-state';
  const YEARS = ['Year 1U', 'Year 2U', 'Year 3U', 'Year 4U'];
  const SECTION_ORDER = [
    'Compulsory Modules', 'Core Modules',
    'Options Range A', 'Options Range B', 'Options Range C'
  ];

  const SMALL_WORDS = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'if',
    'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'with', 'yet'
  ]);

  // ===== DATA LAYER =====

  function titleCase(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/\b\w+/g, (word, idx) => {
      if (idx !== 0 && SMALL_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
  }

  function normalizeSection(section) {
    return section.replace(/\s+/g, ' ').trim();
  }

  function getSectionKey(section) {
    const norm = normalizeSection(section);
    if (norm.startsWith('Compulsory')) return 'Compulsory Modules';
    if (norm.startsWith('Core')) return 'Core Modules';
    if (norm.includes('Range A')) return 'Options Range A';
    if (norm.includes('Range B')) return 'Options Range B';
    if (norm.includes('Range C')) return 'Options Range C';
    return norm;
  }

  function parseCreditRule(creditRule, notes) {
    if (creditRule) {
      const rangeMatch = creditRule.match(/(\d+)\s*-\s*(\d+)\s*credits?/i);
      if (rangeMatch) return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
      const exactMatch = creditRule.match(/(\d+)\s*credits?/i);
      if (exactMatch) return { min: parseInt(exactMatch[1]), max: parseInt(exactMatch[1]) };
    }
    if (notes) {
      const rangeMatch = notes.match(/select\s+(\d+)\s*-\s*(\d+)\s*credits?/i);
      if (rangeMatch) return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
      const exactMatch = notes.match(/select\s+(\d+)\s*credits?/i);
      if (exactMatch) return { min: parseInt(exactMatch[1]), max: parseInt(exactMatch[1]) };
    }
    return null;
  }

  function parseSectionCredits(section) {
    const match = normalizeSection(section).match(/\(\s*(\d+)\s*credits?\s*\)/i);
    return match ? parseInt(match[1]) : null;
  }

  function parseModuleRules(ruleText) {
    if (!ruleText || !ruleText.trim()) return null;

    const text = ruleText.trim();
    let type = null;
    let expression = '';

    if (text.startsWith('IN TAKING THIS MODULE YOU CANNOT TAKE')) {
      type = 'exclusion';
      expression = text.replace('IN TAKING THIS MODULE YOU CANNOT TAKE', '').trim();
    } else if (text.startsWith('BEFORE OR WHILE TAKING THIS MODULE YOU MUST TAKE')) {
      type = 'soft_prereq';
      expression = text.replace('BEFORE OR WHILE TAKING THIS MODULE YOU MUST TAKE', '').trim();
    } else if (text.startsWith('WHILE TAKING THIS MODULE YOU MUST TAKE')) {
      type = 'corequisite';
      expression = text.replace('WHILE TAKING THIS MODULE YOU MUST TAKE', '').trim();
    } else if (text.startsWith('BEFORE TAKING THIS MODULE YOU MUST TAKE')) {
      type = 'hard_prereq';
      expression = text.replace('BEFORE TAKING THIS MODULE YOU MUST TAKE', '').trim();
    } else {
      return null;
    }

    const allCodes = [];

    if (type === 'exclusion') {
      const excludes = expression.split(/\s+OR\s+TAKE\s+/i).map(s => s.replace(/^TAKE\s+/i, '').trim());
      excludes.forEach(c => allCodes.push(c));
      return { type, excludes, groups: [], allCodes };
    }

    // AND binds tighter than OR
    const orGroups = expression.split(/\s+OR\s+TAKE\s+/i);
    const groups = orGroups.map(group => {
      const parts = group.split(/\s+AND\s+TAKE\s+/i).map(s => s.replace(/^TAKE\s+/i, '').trim());
      parts.forEach(c => allCodes.push(c));
      return parts;
    });

    return { type, groups, excludes: [], allCodes };
  }

  function parseAllRules(ruleInput) {
    if (!ruleInput) return [];
    const texts = Array.isArray(ruleInput) ? ruleInput : [ruleInput];
    const rules = [];
    for (const text of texts) {
      const parsed = parseModuleRules(text);
      if (parsed) rules.push(parsed);
    }
    return rules;
  }

  function getEffectiveRuleText(mod) {
    if (mod.rules_by_year) {
      const yearNum = parseInt(mod.year.match(/\d/)[0]);
      const calYear = getAcademicYearKey(STATE.entryYear, yearNum - 1);
      const dataYear = calendarYearToDataYear(calYear);
      if (mod.rules_by_year[dataYear] !== undefined) {
        return mod.rules_by_year[dataYear];
      }
    }
    return mod.module_rules;
  }

  function getAcademicYearKey(entryYear, yearOffset) {
    const startYear = parseInt(entryYear.split('/')[0]);
    const y = startYear + yearOffset;
    return `${y}/${(y + 1) % 10}`;
  }

  function formatYearDisplay(yearKey) {
    const [start] = yearKey.split('/');
    const nextYear = parseInt(start) + 1;
    return `${start}/${String(nextYear).slice(-2)}`;
  }

  function calendarYearToDataYear(calYear) {
    if (STATE.dataYears.includes(calYear)) return calYear;
    const calStart = parseInt(calYear.split('/')[0]);
    let best = null;
    let bestDist = Infinity;
    for (const dy of STATE.dataYears) {
      const dyStart = parseInt(dy.split('/')[0]);
      if ((calStart % 2) === (dyStart % 2)) {
        const dist = Math.abs(calStart - dyStart);
        if (dist < bestDist) { best = dy; bestDist = dist; }
      }
    }
    return best || STATE.dataYears[STATE.dataYears.length - 1];
  }

  function isModuleVisible(mod, entryYear) {
    const yearNum = parseInt(mod.year.match(/\d/)[0]);
    const calYear = getAcademicYearKey(entryYear, yearNum - 1);

    // Discontinued modules only show when the calendar year exactly
    // matches a real data year — no parity-based inference
    if (mod.discontinued) {
      return mod.available_years.includes(calYear);
    }

    const dataYear = calendarYearToDataYear(calYear);
    return mod.available_years.includes(dataYear);
  }

  function isLevel5(code) {
    const match = code.match(/[A-Z]-?(\d)/);
    return match && match[1] === '5';
  }

  function makeUid(code, year) {
    return code + '|' + year;
  }

  function buildModuleIndex() {
    STATE.moduleIndex.clear();
    STATE.codeEntries.clear();
    STATE.ghostModules.clear();

    for (const mod of STATE.modules) {
      const uid = makeUid(mod.module_code, mod.year);
      const effectiveRules = getEffectiveRuleText(mod);
      const enriched = {
        uid: uid,
        code: mod.module_code,
        description: mod.description,
        assessment: mod.assessment,
        credits: parseInt(mod.credits),
        period: mod.period,
        sub_slot: mod.sub_slot,
        year: mod.year,
        section: normalizeSection(mod.section),
        sectionKey: getSectionKey(mod.section),
        credit_rule: mod.credit_rule,
        notes: mod.notes,
        available_years: mod.available_years,
        discontinued: !!mod.discontinued,
        rules: parseAllRules(effectiveRules),
        rawRules: effectiveRules,
        contentSections: mod.content_sections || {},
        dependents: [],       // uids of modules that depend on this one
        exclusionPeers: [],   // uids of mutually exclusive modules
      };
      STATE.moduleIndex.set(uid, enriched);

      // Secondary index: plain code -> all entries
      if (!STATE.codeEntries.has(enriched.code)) {
        STATE.codeEntries.set(enriched.code, []);
      }
      STATE.codeEntries.get(enriched.code).push(enriched);
    }

    // Build reverse dependencies and find ghost modules
    for (const [uid, mod] of STATE.moduleIndex) {
      for (const rule of mod.rules) {
        for (const refCode of rule.allCodes) {
          if (!STATE.codeEntries.has(refCode)) {
            STATE.ghostModules.add(refCode);
            continue;
          }

          for (const target of STATE.codeEntries.get(refCode)) {
            if (rule.type === 'exclusion') {
              if (!target.exclusionPeers.includes(uid)) target.exclusionPeers.push(uid);
              if (!mod.exclusionPeers.includes(target.uid)) mod.exclusionPeers.push(target.uid);
            } else {
              if (!target.dependents.includes(uid)) target.dependents.push(uid);
            }
          }
        }
      }
    }
  }

  // ===== RENDERING =====

  function getVisibleModules(entryYear) {
    const visible = [];
    for (const [, mod] of STATE.moduleIndex) {
      if (isModuleVisible(mod, entryYear)) {
        visible.push(mod);
      }
    }
    return visible;
  }

  function groupByYearAndSection(modules) {
    const structure = {};
    for (const year of YEARS) {
      structure[year] = {};
    }

    for (const mod of modules) {
      const year = mod.year;
      const secKey = mod.sectionKey;
      if (!structure[year]) continue;
      if (!structure[year][secKey]) {
        structure[year][secKey] = {
          modules: [],
          creditRule: null,
          sectionLabel: mod.section,
          notes: mod.notes,
          rawCreditRule: mod.credit_rule,
        };
      }
      structure[year][secKey].modules.push(mod);
    }

    for (const year of YEARS) {
      for (const secKey in structure[year]) {
        const group = structure[year][secKey];
        if (!group.creditRule) {
          group.creditRule = parseCreditRule(group.rawCreditRule, group.notes);
        }
        const periodOrder = { SEM1: 0, SEM2: 1, YEAR: 2 };
        group.modules.sort((a, b) => {
          const pa = periodOrder[a.period] ?? 3;
          const pb = periodOrder[b.period] ?? 3;
          if (pa !== pb) return pa - pb;
          return a.code.localeCompare(b.code);
        });
      }
    }

    return structure;
  }

  function renderModuleCard(mod) {
    const card = document.createElement('div');
    card.className = 'module-card';
    card.dataset.uid = mod.uid;
    card.dataset.code = mod.code;
    card.dataset.period = mod.period;

    if (mod.credits >= 40) card.classList.add('wide-card');
    if (STATE.selectedModules.has(mod.uid)) card.classList.add('selected');

    const periodClass = mod.period === 'SEM1' ? 'sem1' : mod.period === 'SEM2' ? 'sem2' : 'year';

    // Indicators
    const indicators = [];
    if (mod.rules.some(r => r.type === 'hard_prereq' || r.type === 'soft_prereq')) {
      indicators.push('<span class="indicator has-prereqs" title="Has prerequisites"></span>');
    }
    if (mod.rules.some(r => r.type === 'corequisite')) {
      indicators.push('<span class="indicator has-coreqs" title="Has corequisites"></span>');
    }
    if (mod.exclusionPeers.length > 0) {
      indicators.push('<span class="indicator has-exclusions" title="Has exclusions"></span>');
    }
    if (mod.dependents.length > 0) {
      indicators.push('<span class="indicator has-dependents" title="Required by other modules"></span>');
    }

    // Details section
    const hasContent = mod.rules.length > 0 || (mod.contentSections && Object.keys(mod.contentSections).length > 0);
    let detailsInner = '';
    if (mod.rules.length > 0) {
      detailsInner += `<div class="rules-text">${formatRulesForDisplay(mod)}</div>`;
    }
    if (mod.contentSections) {
      for (const [secName, secText] of Object.entries(mod.contentSections)) {
        if (!secText || secText.length < 5) continue;
        const escaped = secText.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        detailsInner += `<div class="content-section"><strong>${secName}</strong><p>${escaped}</p></div>`;
      }
    }

    const safeUid = CSS.escape(mod.uid);
    const detailsHTML = hasContent ? `<div class="card-details${STATE.showDetails ? ' visible' : ''}">${detailsInner}</div>` : '';
    const expandBtn = hasContent ? '<button class="expand-btn" title="Show details">&#9660;</button>' : '';

    card.innerHTML = `
      <div class="card-header">
        <input type="checkbox" class="module-select" id="sel-${safeUid}"
          ${STATE.selectedModules.has(mod.uid) ? 'checked' : ''}>
        <label class="module-code" for="sel-${safeUid}">${mod.code}</label>
        <span class="semester-badge ${periodClass}">${mod.period}</span>
      </div>
      <div class="card-title">${titleCase(mod.description)}</div>
      <div class="card-meta">
        <span class="credits">${mod.credits} cr</span>
        <span class="assessment">${mod.assessment}</span>
        ${expandBtn}
      </div>
      ${detailsHTML}
      ${indicators.length ? '<div class="card-indicators">' + indicators.join('') + '</div>' : ''}
    `;

    // Expand/collapse per-card
    const expBtn = card.querySelector('.expand-btn');
    if (expBtn) {
      expBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const details = card.querySelector('.card-details');
        if (details) {
          const isVisible = details.classList.toggle('visible');
          expBtn.innerHTML = isVisible ? '&#9650;' : '&#9660;';
        }
        if (STATE.activeModule) {
          setTimeout(() => drawDependencyLines(STATE.activeModule), 100);
        }
      });
    }

    // Click handler
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('module-select') || e.target.tagName === 'LABEL' || e.target.classList.contains('expand-btn')) return;
      handleCardClick(mod.uid);
    });

    // Checkbox handler
    const checkbox = card.querySelector('.module-select');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      handleCheckboxChange(mod.uid, e.target.checked);
    });

    return card;
  }

  function formatRulesForDisplay(mod) {
    if (!mod.rules.length) return '';

    const typeLabels = {
      hard_prereq: 'Prerequisites',
      soft_prereq: 'Before or while',
      corequisite: 'Take alongside',
    };

    return mod.rules.map(rule => {
      if (rule.type === 'exclusion') {
        return '<strong>Cannot take with:</strong> ' + rule.excludes.map(c => formatCodeRef(c)).join(' or ');
      }
      const groupStrs = rule.groups.map(group =>
        group.map(c => formatCodeRef(c)).join(' + ')
      );
      return `<strong>${typeLabels[rule.type]}:</strong> ` + groupStrs.join(' <em>or</em> ');
    }).join('<br>');
  }

  function formatCodeRef(code) {
    if (STATE.ghostModules.has(code)) {
      return `<span class="ghost-code" title="Not in current catalogue">${code}*</span>`;
    }
    return code;
  }

  function renderAll() {
    const container = document.getElementById('module-container');
    container.innerHTML = '';
    STATE.visibleSections = [];

    const visible = getVisibleModules(STATE.entryYear);
    const structure = groupByYearAndSection(visible);

    for (const year of YEARS) {
      const yearData = structure[year];
      const yearSections = SECTION_ORDER.filter(s => yearData[s] && yearData[s].modules.length > 0);
      if (yearSections.length === 0) continue;

      const yearNum = parseInt(year.match(/\d/)[0]);
      const activeAcademicYear = formatYearDisplay(getAcademicYearKey(STATE.entryYear, yearNum - 1));

      const section = document.createElement('section');
      section.className = 'year-section';
      section.dataset.year = year;

      const yearHeading = document.createElement('h2');
      yearHeading.className = 'year-heading';
      yearHeading.innerHTML = `${year} <span class="year-academic">(${activeAcademicYear})</span>`;
      section.appendChild(yearHeading);

      // Disclaimer for years beyond our data range
      const calYear = getAcademicYearKey(STATE.entryYear, yearNum - 1);
      if (!STATE.dataYears.includes(calYear)) {
        const disclaimer = document.createElement('p');
        disclaimer.className = 'year-disclaimer';
        disclaimer.textContent = 'Module availability is based on projected data. The selection of modules offered may change for this academic year.';
        section.appendChild(disclaimer);
      }

      for (const secKey of yearSections) {
        const group = yearData[secKey];
        const sectionDiv = document.createElement('div');
        sectionDiv.className = 'section-group';
        sectionDiv.dataset.section = secKey;
        sectionDiv.dataset.year = year;

        const compulsoryCredits = parseSectionCredits(group.sectionLabel);
        const isCompulsory = secKey.startsWith('Compulsory') || secKey.startsWith('Core');

        const heading = document.createElement('h3');
        heading.className = 'section-heading';
        let headingHTML = secKey;

        if (compulsoryCredits) {
          headingHTML += ` <span class="credit-badge">${compulsoryCredits} credits</span>`;
        }

        if (group.creditRule && !isCompulsory) {
          const { min, max } = group.creditRule;
          const rangeStr = min === max ? `${min}` : `${min}-${max}`;
          headingHTML += ` <span class="credit-badge range">${rangeStr} credits</span>`;
          headingHTML += ` <span class="credit-counter" id="counter-${year}-${secKey}">Selected: 0 / ${rangeStr}</span>`;

          STATE.visibleSections.push({ year, secKey, creditRule: group.creditRule });
        }

        heading.innerHTML = headingHTML;
        sectionDiv.appendChild(heading);

        if (group.notes) {
          const noteText = group.notes.replace(/Students will select.*$/i, '').trim();
          if (noteText && noteText.length > 5) {
            const noteEl = document.createElement('p');
            noteEl.className = 'section-note';
            noteEl.textContent = noteText;
            sectionDiv.appendChild(noteEl);
          }
        }

        const grid = document.createElement('div');
        grid.className = 'module-grid';
        for (const mod of group.modules) {
          grid.appendChild(renderModuleCard(mod));
        }
        sectionDiv.appendChild(grid);

        section.appendChild(sectionDiv);
      }

      container.appendChild(section);
    }

    updateCreditSummary();
    applyFilters();

    if (STATE.activeModule) {
      const card = document.querySelector(`[data-uid="${CSS.escape(STATE.activeModule)}"]`);
      if (card) {
        highlightModule(STATE.activeModule);
      } else {
        STATE.activeModule = null;
        clearLines();
      }
    }
  }

  // ===== INTERACTIONS =====

  function handleCardClick(uid) {
    if (STATE.activeModule === uid) {
      STATE.activeModule = null;
      clearHighlights();
      clearLines();
    } else {
      STATE.activeModule = uid;
      highlightModule(uid);
    }
  }

  function clearHighlights() {
    document.querySelectorAll('.module-card').forEach(card => {
      card.classList.remove(
        'highlighted-active', 'highlighted-prereq', 'highlighted-soft-prereq',
        'highlighted-coreq', 'highlighted-exclusion', 'highlighted-dependent', 'dimmed'
      );
    });
  }

  function highlightModule(uid) {
    clearHighlights();
    clearLines();

    const mod = STATE.moduleIndex.get(uid);
    if (!mod) return;

    // Build a map of uid -> highlight CSS class
    const highlightMap = new Map();

    // Prereqs/coreqs from all rules (filtered by year relationship)
    const modYearNum = parseInt(mod.year.match(/\d/)[0]);
    for (const rule of mod.rules) {
      if (rule.type === 'exclusion') continue;
      const cls = rule.type === 'hard_prereq' ? 'highlighted-prereq'
        : rule.type === 'soft_prereq' ? 'highlighted-soft-prereq'
        : 'highlighted-coreq';
      for (const refCode of rule.allCodes) {
        if (STATE.codeEntries.has(refCode)) {
          for (const entry of STATE.codeEntries.get(refCode)) {
            const entryYearNum = parseInt(entry.year.match(/\d/)[0]);
            if (rule.type === 'corequisite' && entryYearNum !== modYearNum) continue;
            if (rule.type === 'hard_prereq' && entryYearNum >= modYearNum) continue;
            if (rule.type === 'soft_prereq' && entryYearNum > modYearNum) continue;
            highlightMap.set(entry.uid, cls);
          }
        }
      }
    }

    // Exclusion peers
    for (const peerUid of mod.exclusionPeers) {
      highlightMap.set(peerUid, 'highlighted-exclusion');
    }

    // Dependents
    for (const depUid of mod.dependents) {
      highlightMap.set(depUid, 'highlighted-dependent');
    }

    document.querySelectorAll('.module-card').forEach(card => {
      const cardUid = card.dataset.uid;
      if (card.classList.contains('search-hidden') || card.classList.contains('period-hidden')) return;

      if (cardUid === uid) {
        card.classList.add('highlighted-active');
      } else if (highlightMap.has(cardUid)) {
        card.classList.add(highlightMap.get(cardUid));
      } else {
        card.classList.add('dimmed');
      }
    });

    drawDependencyLines(uid);
  }

  function handleCheckboxChange(uid, checked) {
    const mod = STATE.moduleIndex.get(uid);
    if (!mod) return;

    if (checked) {
      // ── Pre-check: block illegal selections ──

      // 1. Exclusion conflict
      for (const exUid of mod.exclusionPeers) {
        if (STATE.selectedModules.has(exUid)) {
          const exMod = STATE.moduleIndex.get(exUid);
          showToast(`Blocked: ${mod.code} cannot be taken with ${exMod ? exMod.code : exUid}`, 'warning');
          revertCheckbox(uid, false);
          return;
        }
      }

      // 2. MTHF5036B conditional
      const hasMTHF5036B = [...STATE.selectedModules].some(u => {
        const m = STATE.moduleIndex.get(u);
        return m && m.code === 'MTHF5036B';
      });
      if (hasMTHF5036B && isLevel5(mod.code) && mod.sectionKey === 'Options Range C') {
        showToast(`Blocked: Level 5 module ${mod.code} in Range C not allowed when MTHF5036B is selected`, 'warning');
        revertCheckbox(uid, false);
        return;
      }

      // 2b. Selecting MTHF5036B while a Level 5 Range C module is already selected
      if (mod.code === 'MTHF5036B') {
        for (const selUid of STATE.selectedModules) {
          const selMod = STATE.moduleIndex.get(selUid);
          if (selMod && selMod.sectionKey === 'Options Range C' && isLevel5(selMod.code)) {
            showToast(`Blocked: Cannot select MTHF5036B while Level 5 module ${selMod.code} is in Range C`, 'warning');
            revertCheckbox(uid, false);
            return;
          }
        }
      }

      // 3. Section credit range overflow
      const sectionInfo = STATE.visibleSections.find(s => s.year === mod.year && s.secKey === mod.sectionKey);
      if (sectionInfo) {
        const current = calculateSectionCredits(mod.year, mod.sectionKey);
        if (current + mod.credits > sectionInfo.creditRule.max) {
          showToast(`Blocked: Adding ${mod.code} (${mod.credits}cr) would exceed ${mod.sectionKey} limit of ${sectionInfo.creditRule.max} credits (currently ${current})`, 'warning');
          revertCheckbox(uid, false);
          return;
        }
      }

      // 4. Semester balance check (Year 2U-4U: max 70 per semester)
      if (mod.year === 'Year 2U' || mod.year === 'Year 3U' || mod.year === 'Year 4U') {
        const { sem1, sem2 } = calculateSemesterCredits(mod.year);
        let addSem1 = 0, addSem2 = 0;
        if (mod.period === 'SEM1') addSem1 = mod.credits;
        else if (mod.period === 'SEM2') addSem2 = mod.credits;
        else if (mod.period === 'YEAR') { addSem1 = mod.credits / 2; addSem2 = mod.credits / 2; }

        if (sem1 + addSem1 > 70 || sem2 + addSem2 > 70) {
          const overSem = sem1 + addSem1 > 70 ? 'SEM1' : 'SEM2';
          const overVal = overSem === 'SEM1' ? sem1 + addSem1 : sem2 + addSem2;
          showToast(`Blocked: Adding ${mod.code} would put ${mod.year} ${overSem} at ${overVal} credits (max 70)`, 'warning');
          revertCheckbox(uid, false);
          return;
        }
      }

      // 5. Total year credits (max 120 per year)
      let yearTotal = 0;
      for (const selUid of STATE.selectedModules) {
        const selMod = STATE.moduleIndex.get(selUid);
        if (selMod && selMod.year === mod.year && isModuleVisible(selMod, STATE.entryYear)) {
          yearTotal += selMod.credits;
        }
      }
      if (yearTotal + mod.credits > 120) {
        showToast(`Blocked: Adding ${mod.code} (${mod.credits}cr) would exceed ${mod.year} total of 120 credits (currently ${yearTotal})`, 'warning');
        revertCheckbox(uid, false);
        return;
      }

      // ── All checks passed ──
      STATE.selectedModules.add(uid);

      // ── Auto-select prerequisites ──
      const autoResult = autoSelectPrerequisites(uid);

      const card = document.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
      if (card) card.classList.add('selected');

      // Show feedback about auto-selected prerequisites
      if (autoResult.selected.length > 0 || autoResult.failed.length > 0) {
        let msg = '';
        if (autoResult.selected.length > 0) {
          const codes = autoResult.selected.map(u => {
            const m = STATE.moduleIndex.get(u);
            return m ? m.code : u;
          });
          msg += `Auto-selected ${codes.length} prereq(s): ${codes.join(', ')}`;
        }
        if (autoResult.failed.length > 0) {
          if (msg) msg += '. ';
          msg += `Could not auto-select: ${autoResult.failed.join('; ')}`;
        }
        const duration = msg.length > 80 ? 5500 : 3500;
        showToast(msg, autoResult.failed.length > 0 ? 'warning' : 'info', duration);
      }
    } else {
      STATE.selectedModules.delete(uid);
      const card = document.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
      if (card) card.classList.remove('selected');
    }

    updateCreditSummary();
    saveState();
  }

  function revertCheckbox(uid, value) {
    const cb = document.getElementById(`sel-${CSS.escape(uid)}`);
    if (cb) cb.checked = value;
  }

  // ===== AUTO-SELECT PREREQUISITES =====

  function findBestEntryForCode(code, requiringYear) {
    const entries = STATE.codeEntries.get(code);
    if (!entries) return null;

    const visible = entries.filter(e => isModuleVisible(e, STATE.entryYear));
    if (visible.length === 0) return null;

    // Prefer already selected
    const selected = visible.find(e => STATE.selectedModules.has(e.uid));
    if (selected) return selected;

    // For prerequisites, prefer entries in earlier years
    const reqYearNum = parseInt(requiringYear.match(/\d/)[0]);
    const earlier = visible.filter(e => parseInt(e.year.match(/\d/)[0]) < reqYearNum);
    if (earlier.length > 0) {
      earlier.sort((a, b) => parseInt(b.year.match(/\d/)[0]) - parseInt(a.year.match(/\d/)[0]));
      return earlier[0]; // latest earlier year (closest to requiring module)
    }

    // For corequisites (same year), return any visible
    return visible[0];
  }

  function gatherPrereqs(uid, toSelect, visited) {
    const mod = STATE.moduleIndex.get(uid);
    if (!mod) return;

    // Process each non-exclusion rule
    for (const rule of mod.rules) {
      if (rule.type === 'exclusion') continue;

      // rule.groups = [[codeA, codeB], [codeC]] means (A AND B) OR C
      // Pick the OR group that requires the fewest new selections
      let bestEntries = null;
      let bestNewCount = Infinity;

      for (const andGroup of rule.groups) {
        let groupOk = true;
        const entries = [];
        let newCount = 0;

        for (const code of andGroup) {
          if (STATE.ghostModules.has(code)) continue;
          const entry = findBestEntryForCode(code, mod.year);
          if (!entry) { groupOk = false; break; }
          entries.push(entry);
          if (!STATE.selectedModules.has(entry.uid) && !toSelect.has(entry.uid)) {
            newCount++;
          }
        }

        if (groupOk) {
          const hasReal = entries.length > 0;
          const bestHasReal = bestEntries !== null && bestEntries.length > 0;
          if (bestEntries === null || (hasReal && !bestHasReal) || (hasReal === bestHasReal && newCount < bestNewCount)) {
            bestEntries = entries;
            bestNewCount = newCount;
          }
        }
      }

      if (!bestEntries || bestEntries.length === 0) continue;

      for (const entry of bestEntries) {
        if (STATE.selectedModules.has(entry.uid) || toSelect.has(entry.uid)) continue;
        if (visited.has(entry.uid)) continue;

        toSelect.add(entry.uid);
        visited.add(entry.uid);
        gatherPrereqs(entry.uid, toSelect, visited);
      }
    }
  }

  function canAutoSelect(uid) {
    const mod = STATE.moduleIndex.get(uid);
    if (!mod) return { ok: false, reason: 'not found' };

    // Exclusion conflict
    for (const exUid of mod.exclusionPeers) {
      if (STATE.selectedModules.has(exUid)) {
        const exMod = STATE.moduleIndex.get(exUid);
        return { ok: false, reason: `conflicts with ${exMod ? exMod.code : exUid}` };
      }
    }

    // MTHF5036B conditional
    const hasMTHF5036B = [...STATE.selectedModules].some(u => {
      const m = STATE.moduleIndex.get(u);
      return m && m.code === 'MTHF5036B';
    });
    if (hasMTHF5036B && isLevel5(mod.code) && mod.sectionKey === 'Options Range C') {
      return { ok: false, reason: 'Level 5 Range C blocked by MTHF5036B' };
    }

    // Section credit overflow
    const sectionInfo = STATE.visibleSections.find(s => s.year === mod.year && s.secKey === mod.sectionKey);
    if (sectionInfo) {
      const current = calculateSectionCredits(mod.year, mod.sectionKey);
      if (current + mod.credits > sectionInfo.creditRule.max) {
        return { ok: false, reason: `exceeds ${mod.sectionKey} credit limit in ${mod.year}` };
      }
    }

    // Semester balance (Year 2U-4U: max 70 per semester)
    if (mod.year === 'Year 2U' || mod.year === 'Year 3U' || mod.year === 'Year 4U') {
      const { sem1, sem2 } = calculateSemesterCredits(mod.year);
      let addSem1 = 0, addSem2 = 0;
      if (mod.period === 'SEM1') addSem1 = mod.credits;
      else if (mod.period === 'SEM2') addSem2 = mod.credits;
      else if (mod.period === 'YEAR') { addSem1 = mod.credits / 2; addSem2 = mod.credits / 2; }
      if (sem1 + addSem1 > 70 || sem2 + addSem2 > 70) {
        return { ok: false, reason: `exceeds 70cr semester limit in ${mod.year}` };
      }
    }

    // Year total (max 120)
    let yearTotal = 0;
    for (const selUid of STATE.selectedModules) {
      const selMod = STATE.moduleIndex.get(selUid);
      if (selMod && selMod.year === mod.year && isModuleVisible(selMod, STATE.entryYear)) {
        yearTotal += selMod.credits;
      }
    }
    if (yearTotal + mod.credits > 120) {
      return { ok: false, reason: `exceeds 120cr in ${mod.year}` };
    }

    return { ok: true };
  }

  function autoSelectPrerequisites(uid) {
    const result = { selected: [], failed: [] };
    const toSelect = new Set();
    const visited = new Set([uid]);

    gatherPrereqs(uid, toSelect, visited);

    // Filter out already selected, sort by year (earliest first)
    const newToSelect = [...toSelect].filter(u => !STATE.selectedModules.has(u));
    newToSelect.sort((a, b) => {
      const ma = STATE.moduleIndex.get(a);
      const mb = STATE.moduleIndex.get(b);
      return parseInt(ma.year.match(/\d/)[0]) - parseInt(mb.year.match(/\d/)[0]);
    });

    for (const prereqUid of newToSelect) {
      const check = canAutoSelect(prereqUid);
      if (check.ok) {
        STATE.selectedModules.add(prereqUid);
        const card = document.querySelector(`[data-uid="${CSS.escape(prereqUid)}"]`);
        if (card) {
          card.classList.add('selected');
          const cb = card.querySelector('.module-select');
          if (cb) cb.checked = true;
        }
        result.selected.push(prereqUid);
      } else {
        const prereqMod = STATE.moduleIndex.get(prereqUid);
        result.failed.push(`${prereqMod ? prereqMod.code : prereqUid}: ${check.reason}`);
      }
    }

    return result;
  }

  // ===== SVG DEPENDENCY LINES =====

  function clearLines() {
    const svg = document.getElementById('dependency-svg');
    const defs = svg.querySelector('defs');
    svg.innerHTML = '';
    if (defs) svg.appendChild(defs);
    else initSVGDefs(svg);
  }

  function initSVGDefs(svg) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    const colors = {
      'prereq': '#7c3aed',
      'soft-prereq': '#8b5cf6',
      'coreq': '#2563eb',
      'exclusion': '#dc2626',
      'dependent': '#059669',
    };

    for (const [name, color] of Object.entries(colors)) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', `arrow-${name}`);
      marker.setAttribute('viewBox', '0 0 10 7');
      marker.setAttribute('refX', '10');
      marker.setAttribute('refY', '3.5');
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      marker.setAttribute('fill', color);

      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', '0 0, 10 3.5, 0 7');
      marker.appendChild(polygon);
      defs.appendChild(marker);
    }

    svg.appendChild(defs);
  }

  function getCardRect(uid) {
    const el = document.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
    if (!el || el.classList.contains('search-hidden') || el.classList.contains('period-hidden')) return null;

    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    return {
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      w: rect.width,
      h: rect.height,
      cx: rect.left + scrollX + rect.width / 2,
      cy: rect.top + scrollY + rect.height / 2,
    };
  }

  function drawLine(svg, fromRect, toRect, lineType, lineIndex, totalLines) {
    const styleMap = {
      hard_prereq: { stroke: '#7c3aed', dash: '', marker: 'arrow-prereq' },
      soft_prereq: { stroke: '#8b5cf6', dash: '6,4', marker: 'arrow-soft-prereq' },
      corequisite: { stroke: '#2563eb', dash: '3,4', marker: 'arrow-coreq' },
      exclusion:   { stroke: '#dc2626', dash: '8,4', marker: 'arrow-exclusion' },
      dependent:   { stroke: '#059669', dash: '', marker: 'arrow-dependent' },
    };

    const style = styleMap[lineType] || styleMap.hard_prereq;

    const t = totalLines <= 1 ? 0 : (lineIndex / (totalLines - 1)) * 2 - 1;
    const spreadX = t * Math.min(fromRect.w * 0.35, 40);
    const spreadY = t * Math.min(fromRect.h * 0.3, 20);
    const wobble = t * 35;

    let x1, y1, x2, y2;

    if (Math.abs(fromRect.cy - toRect.cy) < 60) {
      if (fromRect.cx < toRect.cx) {
        x1 = fromRect.x + fromRect.w;
        y1 = fromRect.cy + spreadY;
        x2 = toRect.x;
        y2 = toRect.cy + spreadY;
      } else {
        x1 = fromRect.x;
        y1 = fromRect.cy + spreadY;
        x2 = toRect.x + toRect.w;
        y2 = toRect.cy + spreadY;
      }
      const dx = Math.abs(x2 - x1);
      const controlOffset = Math.max(dx * 0.3, 30);
      const arcY = -30 + wobble;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + (x2 > x1 ? controlOffset : -controlOffset)} ${y1 + arcY}, ${x2 + (x2 > x1 ? -controlOffset : controlOffset)} ${y2 + arcY}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', style.stroke);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-opacity', '0.7');
      if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
      path.setAttribute('marker-end', `url(#${style.marker})`);
      svg.appendChild(path);
    } else {
      if (fromRect.cy < toRect.cy) {
        x1 = fromRect.cx + spreadX;
        y1 = fromRect.y + fromRect.h;
        x2 = toRect.cx + spreadX;
        y2 = toRect.y;
      } else {
        x1 = fromRect.cx + spreadX;
        y1 = fromRect.y;
        x2 = toRect.cx + spreadX;
        y2 = toRect.y + toRect.h;
      }

      const dy = Math.abs(y2 - y1);
      const controlOffset = Math.max(dy * 0.35, 40);
      const isDown = y2 > y1;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + wobble} ${y1 + (isDown ? controlOffset : -controlOffset)}, ${x2 + wobble} ${y2 + (isDown ? -controlOffset : controlOffset)}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', style.stroke);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-opacity', '0.7');
      if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
      path.setAttribute('marker-end', `url(#${style.marker})`);
      svg.appendChild(path);
    }
  }

  function drawDependencyLines(uid) {
    clearLines();
    const svg = document.getElementById('dependency-svg');

    svg.style.width = document.documentElement.scrollWidth + 'px';
    svg.style.height = document.documentElement.scrollHeight + 'px';

    const mod = STATE.moduleIndex.get(uid);
    if (!mod) return;

    const activeRect = getCardRect(uid);
    if (!activeRect) return;

    const lines = [];

    // Lines TO prerequisites (filtered by year relationship)
    const modYearNum = parseInt(mod.year.match(/\d/)[0]);
    for (const rule of mod.rules) {
      if (rule.type === 'exclusion') continue;
      for (const group of rule.groups) {
        for (const prereqCode of group) {
          if (STATE.ghostModules.has(prereqCode)) continue;
          const entries = STATE.codeEntries.get(prereqCode) || [];
          for (const entry of entries) {
            const entryYearNum = parseInt(entry.year.match(/\d/)[0]);
            if (rule.type === 'corequisite' && entryYearNum !== modYearNum) continue;
            if (rule.type === 'hard_prereq' && entryYearNum >= modYearNum) continue;
            if (rule.type === 'soft_prereq' && entryYearNum > modYearNum) continue;
            const fromRect = getCardRect(entry.uid);
            if (fromRect) {
              lines.push({ from: fromRect, to: activeRect, type: rule.type });
            }
          }
        }
      }
    }

    // Lines FROM active to dependents (stored as uids)
    for (const depUid of mod.dependents) {
      const depRect = getCardRect(depUid);
      if (!depRect) continue;
      lines.push({ from: activeRect, to: depRect, type: 'dependent' });
    }

    // Exclusion lines (stored as uids)
    for (const exUid of mod.exclusionPeers) {
      const exRect = getCardRect(exUid);
      if (!exRect) continue;
      lines.push({ from: activeRect, to: exRect, type: 'exclusion' });
    }

    const total = lines.length;
    lines.forEach((line, i) => {
      drawLine(svg, line.from, line.to, line.type, i, total);
    });
  }

  let resizeTimer;
  function handleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (STATE.activeModule) {
        drawDependencyLines(STATE.activeModule);
      }
    }, 150);
  }

  // ===== CREDIT VALIDATION =====

  function calculateSectionCredits(year, secKey) {
    let total = 0;
    for (const uid of STATE.selectedModules) {
      const mod = STATE.moduleIndex.get(uid);
      if (mod && mod.year === year && mod.sectionKey === secKey) {
        total += mod.credits;
      }
    }
    return total;
  }

  function calculateSemesterCredits(year) {
    let sem1 = 0, sem2 = 0;
    for (const uid of STATE.selectedModules) {
      const mod = STATE.moduleIndex.get(uid);
      if (!mod || mod.year !== year) continue;
      if (!isModuleVisible(mod, STATE.entryYear)) continue;
      if (mod.period === 'SEM1') sem1 += mod.credits;
      else if (mod.period === 'SEM2') sem2 += mod.credits;
      else if (mod.period === 'YEAR') {
        sem1 += mod.credits / 2;
        sem2 += mod.credits / 2;
      }
    }
    return { sem1, sem2 };
  }

  function updateCreditSummary() {
    const container = document.getElementById('credit-summary');

    for (const { year, secKey, creditRule } of STATE.visibleSections) {
      const counter = document.getElementById(`counter-${year}-${secKey}`);
      if (!counter) continue;

      const selected = calculateSectionCredits(year, secKey);
      const { min, max } = creditRule;
      const rangeStr = min === max ? `${min}` : `${min}-${max}`;
      counter.textContent = `Selected: ${selected} / ${rangeStr}`;

      counter.className = 'credit-counter';
      if (selected > 0) {
        if (selected >= min && selected <= max) {
          counter.classList.add('valid');
        } else {
          counter.classList.add('warning');
        }
      }
    }

    const hasSelections = STATE.selectedModules.size > 0;
    container.className = hasSelections ? 'visible' : '';

    if (!hasSelections) {
      container.innerHTML = '';
      return;
    }

    let html = '<div class="credit-row">';

    for (const year of YEARS) {
      let total = 0;
      for (const uid of STATE.selectedModules) {
        const mod = STATE.moduleIndex.get(uid);
        if (mod && mod.year === year && isModuleVisible(mod, STATE.entryYear)) {
          total += mod.credits;
        }
      }
      if (total > 0) {
        const cls = total === 120 ? 'valid' : total > 120 ? 'warning' : '';
        html += `<span class="credit-item ${cls}"><span class="label">${year}:</span> <span class="value">${total}/120</span></span>`;
      }
    }

    for (const year of ['Year 2U', 'Year 3U', 'Year 4U']) {
      const { sem1, sem2 } = calculateSemesterCredits(year);
      if (sem1 > 0 || sem2 > 0) {
        const warn1 = sem1 > 70 ? ' warning' : '';
        const warn2 = sem2 > 70 ? ' warning' : '';
        html += `<span class="credit-item"><span class="label">${year}:</span> <span class="value${warn1}">S1=${sem1}</span> <span class="value${warn2}">S2=${sem2}</span></span>`;
      }
    }

    html += '</div>';
    container.innerHTML = html;
  }

  // ===== SEARCH & FILTER =====

  function applyFilters() {
    document.querySelectorAll('.module-card').forEach(card => {
      const uid = card.dataset.uid;
      const mod = STATE.moduleIndex.get(uid);
      if (!mod) return;

      const query = STATE.searchQuery.toLowerCase();
      const matchesSearch = !query ||
        mod.code.toLowerCase().includes(query) ||
        mod.description.toLowerCase().includes(query);
      card.classList.toggle('search-hidden', !matchesSearch);

      const matchesPeriod = STATE.periodFilter === 'all' || mod.period === STATE.periodFilter;
      card.classList.toggle('period-hidden', !matchesPeriod);
    });

    if (STATE.activeModule) {
      const card = document.querySelector(`[data-uid="${CSS.escape(STATE.activeModule)}"]`);
      if (card && (card.classList.contains('search-hidden') || card.classList.contains('period-hidden'))) {
        STATE.activeModule = null;
        clearHighlights();
        clearLines();
      }
    }
  }

  let searchTimer;
  function handleSearch(e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      STATE.searchQuery = e.target.value;
      applyFilters();
      if (STATE.activeModule) {
        clearHighlights();
        clearLines();
        STATE.activeModule = null;
      }
    }, 200);
  }

  function handlePeriodFilter(e) {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;

    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.periodFilter = btn.dataset.period;
    applyFilters();

    if (STATE.activeModule) {
      clearHighlights();
      clearLines();
      STATE.activeModule = null;
    }
  }

  function handleEntryYearChange(e) {
    STATE.entryYear = e.target.value;
    STATE.activeModule = null;
    clearLines();
    buildModuleIndex();   // rebuild so year-specific rules take effect
    renderAll();
    saveState();
  }

  function handleToggleDetails() {
    STATE.showDetails = !STATE.showDetails;
    document.querySelectorAll('.card-details').forEach(el => {
      el.classList.toggle('visible', STATE.showDetails);
    });
    document.querySelectorAll('.expand-btn').forEach(btn => {
      btn.innerHTML = STATE.showDetails ? '&#9650;' : '&#9660;';
    });
    const btn = document.getElementById('toggle-details');
    btn.textContent = STATE.showDetails ? 'Hide All' : 'Details';

    if (STATE.activeModule) {
      setTimeout(() => drawDependencyLines(STATE.activeModule), 100);
    }
    saveState();
  }

  function handleToggleTheme() {
    STATE.darkMode = !STATE.darkMode;
    document.documentElement.setAttribute('data-theme', STATE.darkMode ? 'dark' : 'light');
    document.getElementById('toggle-theme').textContent = STATE.darkMode ? 'Light' : 'Dark';
    saveState();
  }

  function handleSelectCore() {
    const visible = getVisibleModules(STATE.entryYear);
    const core = visible.filter(mod =>
      mod.sectionKey.startsWith('Compulsory') || mod.sectionKey.startsWith('Core')
    );

    let count = 0;
    for (const mod of core) {
      if (STATE.selectedModules.has(mod.uid)) continue;
      STATE.selectedModules.add(mod.uid);
      const card = document.querySelector(`[data-uid="${CSS.escape(mod.uid)}"]`);
      if (card) {
        card.classList.add('selected');
        const cb = card.querySelector('.module-select');
        if (cb) cb.checked = true;
      }
      count++;
    }

    updateCreditSummary();
    saveState();

    if (count > 0) {
      showToast(`Selected ${count} compulsory/core module(s)`, 'info');
    } else {
      showToast('All core modules already selected', 'info');
    }
  }

  function handleClearSelection() {
    STATE.selectedModules.clear();
    document.querySelectorAll('.module-card.selected').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.module-select').forEach(cb => cb.checked = false);
    updateCreditSummary();
    saveState();
    showToast('Selection cleared', 'info');
  }

  function handleExport() {
    if (STATE.selectedModules.size === 0) {
      showToast('No modules selected to export', 'info');
      return;
    }

    let text = `UEA MMath Module Pathway (Entry: ${STATE.entryYear})\n`;
    text += '='.repeat(50) + '\n\n';

    for (const year of YEARS) {
      const yearMods = [];
      for (const uid of STATE.selectedModules) {
        const mod = STATE.moduleIndex.get(uid);
        if (mod && mod.year === year) yearMods.push(mod);
      }
      if (yearMods.length === 0) continue;

      const yearNum = parseInt(year.match(/\d/)[0]);
      const academicYear = formatYearDisplay(getAcademicYearKey(STATE.entryYear, yearNum - 1));
      text += `${year} (${academicYear})\n`;
      text += '-'.repeat(30) + '\n';

      yearMods.sort((a, b) => a.code.localeCompare(b.code));
      let yearTotal = 0;
      for (const mod of yearMods) {
        text += `  ${mod.code}  ${titleCase(mod.description).padEnd(40)} ${mod.period.padEnd(5)} ${mod.credits}cr\n`;
        yearTotal += mod.credits;
      }
      text += `  ${''.padEnd(55)} Total: ${yearTotal}cr\n\n`;
    }

    navigator.clipboard.writeText(text).then(() => {
      showToast('Pathway copied to clipboard', 'success');
    }).catch(() => {
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mmath_pathway.txt';
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Pathway downloaded', 'success');
    });
  }

  // ===== TOAST NOTIFICATIONS =====

  function showToast(message, type, duration) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type || 'info'}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), duration || 3500);
  }

  // ===== PERSISTENCE =====

  function saveState() {
    try {
      const data = {
        selectedModules: [...STATE.selectedModules],
        entryYear: STATE.entryYear,
        showDetails: STATE.showDetails,
        darkMode: STATE.darkMode,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.selectedModules) {
        STATE.selectedModules = new Set(data.selectedModules);
      }
      if (data.entryYear) {
        STATE.entryYear = data.entryYear;
        document.getElementById('entry-year').value = data.entryYear;
      }
      if (data.showDetails !== undefined) {
        STATE.showDetails = data.showDetails;
      }
      if (data.darkMode) {
        STATE.darkMode = true;
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('toggle-theme').textContent = 'Light';
      }
    } catch (e) { /* ignore */ }
  }

  // ===== INIT =====

  function attachEventListeners() {
    document.getElementById('entry-year').addEventListener('change', handleEntryYearChange);
    document.getElementById('search-input').addEventListener('input', handleSearch);
    document.querySelector('.filter-group').addEventListener('click', handlePeriodFilter);
    document.getElementById('toggle-details').addEventListener('click', handleToggleDetails);
    document.getElementById('select-core').addEventListener('click', handleSelectCore);
    document.getElementById('clear-selection').addEventListener('click', handleClearSelection);
    document.getElementById('export-selection').addEventListener('click', handleExport);
    document.getElementById('toggle-theme').addEventListener('click', handleToggleTheme);
    window.addEventListener('resize', handleResize);

    if (STATE.showDetails) {
      document.getElementById('toggle-details').textContent = 'Hide Details';
    }
  }

  function buildEntryYearDropdown() {
    const select = document.getElementById('entry-year');
    const dataStarts = STATE.dataYears.map(y => parseInt(y.split('/')[0])).sort((a, b) => a - b);
    const earliest = dataStarts[0];
    const latest = dataStarts[dataStarts.length - 1];

    const entryStarts = [];
    for (let y = earliest; y <= latest; y++) {
      entryStarts.push(y);
    }

    select.innerHTML = '';
    for (const y of entryStarts) {
      const key = `${y}/${(y + 1) % 10}`;
      const display = `${y}/${String(y + 1).slice(-2)}`;
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = display;
      select.appendChild(opt);
    }

    const options = [...select.options].map(o => o.value);
    if (options.includes(STATE.entryYear)) {
      select.value = STATE.entryYear;
    } else {
      STATE.entryYear = options[options.length - 1];
      select.value = STATE.entryYear;
    }
  }

  async function init() {
    loadState();

    try {
      const resp = await fetch('data/uea_modules_combined.json');
      const raw = await resp.json();
      STATE.modules = raw.modules;
      STATE.dataYears = (raw.academic_years || ['2024/5', '2025/6']).sort();
    } catch (e) {
      document.getElementById('module-container').innerHTML =
        '<p style="padding:40px;text-align:center;color:#dc2626;">Failed to load module data. Please run from a local server (e.g. <code>python3 -m http.server</code>).</p>';
      return;
    }

    buildEntryYearDropdown();
    buildModuleIndex();

    const svg = document.getElementById('dependency-svg');
    initSVGDefs(svg);

    renderAll();
    attachEventListeners();
    updateControlsHeight();
  }

  function updateControlsHeight() {
    const controls = document.getElementById('controls');
    if (controls) {
      document.documentElement.style.setProperty('--controls-height', controls.offsetHeight + 'px');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('resize', () => updateControlsHeight());
})();

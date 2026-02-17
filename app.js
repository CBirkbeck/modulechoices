/* ===================================================================
   UEA MMath Module Catalogue – app.js
   Single-page interactive module browser with dependency visualisation
   =================================================================== */

(function () {
  'use strict';

  // ===== STATE =====
  const STATE = {
    entryYear: '2025/6',
    activeModule: null,
    selectedModules: new Set(),
    searchQuery: '',
    periodFilter: 'all',
    showDetails: false,
    modules: [],
    moduleIndex: new Map(),
    ghostModules: new Set(),
    visibleSections: [],
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

  function getAcademicYearLabel(entryYear, yearOffset) {
    // Entry "2025/6" means start year 2025; Year 2 is 2026/7, etc.
    const startYear = parseInt(entryYear.split('/')[0]);
    const y = startYear + yearOffset;
    return `${y}/${String(y + 1).slice(-2)}`;
  }

  function isModuleVisible(mod, entryYear) {
    // available_years reflects which entry-cohort pathway the module is on,
    // so just check if this entry year is listed.
    return mod.available_years.includes(entryYear);
  }

  function isLevel5(code) {
    // Level digit is first digit after alpha prefix
    const match = code.match(/[A-Z]-?(\d)/);
    return match && match[1] === '5';
  }

  function buildModuleIndex() {
    STATE.moduleIndex.clear();
    STATE.ghostModules.clear();

    for (const mod of STATE.modules) {
      const enriched = {
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
        rules: parseModuleRules(mod.module_rules),
        rawRules: mod.module_rules,
        dependents: [],
        exclusionPeers: [],
      };
      STATE.moduleIndex.set(enriched.code, enriched);
    }

    // Build reverse dependencies and find ghost modules
    for (const [code, mod] of STATE.moduleIndex) {
      if (!mod.rules) continue;

      for (const refCode of mod.rules.allCodes) {
        if (!STATE.moduleIndex.has(refCode)) {
          STATE.ghostModules.add(refCode);
          continue;
        }

        if (mod.rules.type === 'exclusion') {
          const peer = STATE.moduleIndex.get(refCode);
          if (!peer.exclusionPeers.includes(code)) peer.exclusionPeers.push(code);
          if (!mod.exclusionPeers.includes(refCode)) mod.exclusionPeers.push(refCode);
        } else {
          const target = STATE.moduleIndex.get(refCode);
          if (!target.dependents.includes(code)) target.dependents.push(code);
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

    // Parse credit rules per section
    for (const year of YEARS) {
      for (const secKey in structure[year]) {
        const group = structure[year][secKey];
        if (!group.creditRule) {
          group.creditRule = parseCreditRule(group.rawCreditRule, group.notes);
        }
        // Sort modules: SEM1, SEM2, YEAR, then by code
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
    card.dataset.code = mod.code;
    card.dataset.period = mod.period;

    if (mod.credits >= 40) card.classList.add('wide-card');
    if (STATE.selectedModules.has(mod.code)) card.classList.add('selected');

    const periodClass = mod.period === 'SEM1' ? 'sem1' : mod.period === 'SEM2' ? 'sem2' : 'year';

    // Indicators
    const indicators = [];
    if (mod.rules && (mod.rules.type === 'hard_prereq' || mod.rules.type === 'soft_prereq')) {
      indicators.push('<span class="indicator has-prereqs" title="Has prerequisites"></span>');
    }
    if (mod.rules && mod.rules.type === 'corequisite') {
      indicators.push('<span class="indicator has-coreqs" title="Has corequisites"></span>');
    }
    if (mod.exclusionPeers.length > 0) {
      indicators.push('<span class="indicator has-exclusions" title="Has exclusions"></span>');
    }
    if (mod.dependents.length > 0) {
      indicators.push('<span class="indicator has-dependents" title="Required by other modules"></span>');
    }

    // Details section
    let detailsHTML = '';
    if (mod.rawRules) {
      const rulesFormatted = formatRulesForDisplay(mod);
      detailsHTML = `<div class="card-details${STATE.showDetails ? ' visible' : ''}">
        <div class="rules-text">${rulesFormatted}</div>
      </div>`;
    }

    card.innerHTML = `
      <div class="card-header">
        <input type="checkbox" class="module-select" id="sel-${mod.code}"
          ${STATE.selectedModules.has(mod.code) ? 'checked' : ''}>
        <label class="module-code" for="sel-${mod.code}">${mod.code}</label>
        <span class="semester-badge ${periodClass}">${mod.period}</span>
      </div>
      <div class="card-title">${titleCase(mod.description)}</div>
      <div class="card-meta">
        <span class="credits">${mod.credits} cr</span>
        <span class="assessment">${mod.assessment}</span>
      </div>
      ${detailsHTML}
      ${indicators.length ? '<div class="card-indicators">' + indicators.join('') + '</div>' : ''}
    `;

    // Click handler (not on checkbox)
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('module-select') || e.target.tagName === 'LABEL') return;
      handleCardClick(mod.code);
    });

    // Checkbox handler
    const checkbox = card.querySelector('.module-select');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      handleCheckboxChange(mod.code, e.target.checked);
    });

    return card;
  }

  function formatRulesForDisplay(mod) {
    if (!mod.rules) return '';
    const parts = [];

    if (mod.rules.type === 'exclusion') {
      parts.push('<strong>Cannot take with:</strong> ');
      parts.push(mod.rules.excludes.map(c => formatCodeRef(c)).join(' or '));
    } else {
      const typeLabels = {
        hard_prereq: 'Prerequisites',
        soft_prereq: 'Before or while',
        corequisite: 'Take alongside',
      };
      parts.push(`<strong>${typeLabels[mod.rules.type]}:</strong> `);
      const groupStrs = mod.rules.groups.map(group =>
        group.map(c => formatCodeRef(c)).join(' + ')
      );
      parts.push(groupStrs.join(' <em>or</em> '));
    }

    return parts.join('');
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
      const activeAcademicYear = getAcademicYearLabel(STATE.entryYear, yearNum - 1);

      const section = document.createElement('section');
      section.className = 'year-section';
      section.dataset.year = year;

      const yearHeading = document.createElement('h2');
      yearHeading.className = 'year-heading';
      yearHeading.innerHTML = `${year} <span class="year-academic">(${activeAcademicYear})</span>`;
      section.appendChild(yearHeading);

      for (const secKey of yearSections) {
        const group = yearData[secKey];
        const sectionDiv = document.createElement('div');
        sectionDiv.className = 'section-group';
        sectionDiv.dataset.section = secKey;
        sectionDiv.dataset.year = year;

        const compulsoryCredits = parseSectionCredits(group.sectionLabel);
        const isCompulsory = secKey.startsWith('Compulsory') || secKey.startsWith('Core');

        // Section heading
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

        // Special notes
        if (group.notes) {
          const noteText = group.notes.replace(/Students will select.*$/i, '').trim();
          if (noteText && noteText.length > 5) {
            const noteEl = document.createElement('p');
            noteEl.className = 'section-note';
            noteEl.textContent = noteText;
            sectionDiv.appendChild(noteEl);
          }
        }

        // Module grid
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

    // If there was an active module, try to re-highlight
    if (STATE.activeModule) {
      const card = document.querySelector(`[data-code="${STATE.activeModule}"]`);
      if (card) {
        highlightModule(STATE.activeModule);
      } else {
        STATE.activeModule = null;
        clearLines();
      }
    }
  }

  // ===== INTERACTIONS =====

  function handleCardClick(code) {
    if (STATE.activeModule === code) {
      STATE.activeModule = null;
      clearHighlights();
      clearLines();
    } else {
      STATE.activeModule = code;
      highlightModule(code);
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

  function highlightModule(code) {
    clearHighlights();
    clearLines();

    const mod = STATE.moduleIndex.get(code);
    if (!mod) return;

    const relatedCodes = new Set([code]);

    // Find prereqs/coreqs of this module
    if (mod.rules && mod.rules.type !== 'exclusion') {
      for (const c of mod.rules.allCodes) {
        if (STATE.moduleIndex.has(c)) relatedCodes.add(c);
      }
    }

    // Find exclusion peers
    for (const c of mod.exclusionPeers) {
      relatedCodes.add(c);
    }

    // Find dependents
    for (const c of mod.dependents) {
      relatedCodes.add(c);
    }

    // Apply classes
    document.querySelectorAll('.module-card').forEach(card => {
      const cardCode = card.dataset.code;
      if (card.classList.contains('search-hidden') || card.classList.contains('period-hidden')) return;

      if (cardCode === code) {
        card.classList.add('highlighted-active');
      } else if (relatedCodes.has(cardCode)) {
        // Determine relationship type
        if (mod.exclusionPeers.includes(cardCode)) {
          card.classList.add('highlighted-exclusion');
        } else if (mod.dependents.includes(cardCode)) {
          card.classList.add('highlighted-dependent');
        } else if (mod.rules) {
          if (mod.rules.type === 'hard_prereq') card.classList.add('highlighted-prereq');
          else if (mod.rules.type === 'soft_prereq') card.classList.add('highlighted-soft-prereq');
          else if (mod.rules.type === 'corequisite') card.classList.add('highlighted-coreq');
        }
      } else {
        card.classList.add('dimmed');
      }
    });

    drawDependencyLines(code);
  }

  function handleCheckboxChange(code, checked) {
    const mod = STATE.moduleIndex.get(code);
    if (!mod) return;

    if (checked) {
      // ── Pre-check: block illegal selections ──

      // 1. Exclusion conflict
      for (const exCode of mod.exclusionPeers) {
        if (STATE.selectedModules.has(exCode)) {
          showToast(`Blocked: ${code} cannot be taken with ${exCode}`, 'warning');
          revertCheckbox(code, false);
          return;
        }
      }

      // 2. MTHF5036B conditional: selecting a Level 5 Range C module while MTHF5036B is selected
      if (STATE.selectedModules.has('MTHF5036B') && isLevel5(code) && mod.sectionKey === 'Options Range C') {
        showToast(`Blocked: Level 5 module ${code} in Range C not allowed when MTHF5036B is selected`, 'warning');
        revertCheckbox(code, false);
        return;
      }

      // 2b. Selecting MTHF5036B while a Level 5 Range C module is already selected
      if (code === 'MTHF5036B') {
        for (const selCode of STATE.selectedModules) {
          const selMod = STATE.moduleIndex.get(selCode);
          if (selMod && selMod.sectionKey === 'Options Range C' && isLevel5(selCode)) {
            showToast(`Blocked: Cannot select MTHF5036B while Level 5 module ${selCode} is in Range C`, 'warning');
            revertCheckbox(code, false);
            return;
          }
        }
      }

      // 3. Section credit range overflow
      const sectionInfo = STATE.visibleSections.find(s => s.year === mod.year && s.secKey === mod.sectionKey);
      if (sectionInfo) {
        const current = calculateSectionCredits(mod.year, mod.sectionKey);
        if (current + mod.credits > sectionInfo.creditRule.max) {
          showToast(`Blocked: Adding ${code} (${mod.credits}cr) would exceed ${mod.sectionKey} limit of ${sectionInfo.creditRule.max} credits (currently ${current})`, 'warning');
          revertCheckbox(code, false);
          return;
        }
      }

      // 4. Semester balance check (Year 3U and 4U: max 70 per semester)
      if (mod.year === 'Year 3U' || mod.year === 'Year 4U') {
        const { sem1, sem2 } = calculateSemesterCredits(mod.year);
        let addSem1 = 0, addSem2 = 0;
        if (mod.period === 'SEM1') addSem1 = mod.credits;
        else if (mod.period === 'SEM2') addSem2 = mod.credits;
        else if (mod.period === 'YEAR') { addSem1 = mod.credits / 2; addSem2 = mod.credits / 2; }

        if (sem1 + addSem1 > 70 || sem2 + addSem2 > 70) {
          const overSem = sem1 + addSem1 > 70 ? 'SEM1' : 'SEM2';
          const overVal = overSem === 'SEM1' ? sem1 + addSem1 : sem2 + addSem2;
          showToast(`Blocked: Adding ${code} would put ${mod.year} ${overSem} at ${overVal} credits (max 70)`, 'warning');
          revertCheckbox(code, false);
          return;
        }
      }

      // 5. Total year credits (max 120 per year)
      let yearTotal = 0;
      for (const selCode of STATE.selectedModules) {
        const selMod = STATE.moduleIndex.get(selCode);
        if (selMod && selMod.year === mod.year && isModuleVisible(selMod, STATE.entryYear)) {
          yearTotal += selMod.credits;
        }
      }
      if (yearTotal + mod.credits > 120) {
        showToast(`Blocked: Adding ${code} (${mod.credits}cr) would exceed ${mod.year} total of 120 credits (currently ${yearTotal})`, 'warning');
        revertCheckbox(code, false);
        return;
      }

      // ── All checks passed, add it ──
      STATE.selectedModules.add(code);
    } else {
      STATE.selectedModules.delete(code);
    }

    const card = document.querySelector(`[data-code="${code}"]`);
    if (card) {
      card.classList.toggle('selected', checked);
    }

    updateCreditSummary();
    saveState();
  }

  function revertCheckbox(code, value) {
    const cb = document.getElementById(`sel-${code}`);
    if (cb) cb.checked = value;
  }

  // ===== SVG DEPENDENCY LINES =====

  function clearLines() {
    const svg = document.getElementById('dependency-svg');
    // Keep defs, remove everything else
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

  function getCardRect(code) {
    const el = document.querySelector(`[data-code="${code}"]`);
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

  function drawLine(svg, fromRect, toRect, lineType) {
    const styleMap = {
      hard_prereq: { stroke: '#7c3aed', dash: '', marker: 'arrow-prereq' },
      soft_prereq: { stroke: '#8b5cf6', dash: '6,4', marker: 'arrow-soft-prereq' },
      corequisite: { stroke: '#2563eb', dash: '3,4', marker: 'arrow-coreq' },
      exclusion:   { stroke: '#dc2626', dash: '8,4', marker: 'arrow-exclusion' },
      dependent:   { stroke: '#059669', dash: '', marker: 'arrow-dependent' },
    };

    const style = styleMap[lineType] || styleMap.hard_prereq;

    // Determine start/end points
    let x1, y1, x2, y2;

    if (Math.abs(fromRect.cy - toRect.cy) < 60) {
      // Same vertical level - connect side to side
      if (fromRect.cx < toRect.cx) {
        x1 = fromRect.x + fromRect.w;
        y1 = fromRect.cy;
        x2 = toRect.x;
        y2 = toRect.cy;
      } else {
        x1 = fromRect.x;
        y1 = fromRect.cy;
        x2 = toRect.x + toRect.w;
        y2 = toRect.cy;
      }
      const dx = Math.abs(x2 - x1);
      const controlOffset = Math.max(dx * 0.3, 30);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + (x2 > x1 ? controlOffset : -controlOffset)} ${y1 - 30}, ${x2 + (x2 > x1 ? -controlOffset : controlOffset)} ${y2 - 30}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', style.stroke);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-opacity', '0.7');
      if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
      path.setAttribute('marker-end', `url(#${style.marker})`);
      svg.appendChild(path);
    } else {
      // Different vertical levels - connect bottom to top
      if (fromRect.cy < toRect.cy) {
        x1 = fromRect.cx;
        y1 = fromRect.y + fromRect.h;
        x2 = toRect.cx;
        y2 = toRect.y;
      } else {
        x1 = fromRect.cx;
        y1 = fromRect.y;
        x2 = toRect.cx;
        y2 = toRect.y + toRect.h;
      }

      const dy = Math.abs(y2 - y1);
      const controlOffset = Math.max(dy * 0.35, 40);
      const isDown = y2 > y1;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + (isDown ? controlOffset : -controlOffset)}, ${x2} ${y2 + (isDown ? -controlOffset : controlOffset)}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', style.stroke);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-opacity', '0.7');
      if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
      path.setAttribute('marker-end', `url(#${style.marker})`);
      svg.appendChild(path);
    }
  }

  function drawDependencyLines(activeCode) {
    clearLines();
    const svg = document.getElementById('dependency-svg');

    // Resize SVG to cover full document
    svg.style.width = document.documentElement.scrollWidth + 'px';
    svg.style.height = document.documentElement.scrollHeight + 'px';

    const mod = STATE.moduleIndex.get(activeCode);
    if (!mod) return;

    const activeRect = getCardRect(activeCode);
    if (!activeRect) return;

    // Lines TO prerequisites (from prereq to active)
    if (mod.rules && mod.rules.type !== 'exclusion') {
      for (const group of mod.rules.groups) {
        for (const prereqCode of group) {
          if (STATE.ghostModules.has(prereqCode)) continue;
          const fromRect = getCardRect(prereqCode);
          if (fromRect) {
            drawLine(svg, fromRect, activeRect, mod.rules.type);
          }
        }
      }
    }

    // Lines FROM active to dependents
    for (const depCode of mod.dependents) {
      const depRect = getCardRect(depCode);
      if (!depRect) continue;
      const depMod = STATE.moduleIndex.get(depCode);
      if (depMod && depMod.rules) {
        drawLine(svg, activeRect, depRect, 'dependent');
      }
    }

    // Exclusion lines
    for (const exCode of mod.exclusionPeers) {
      const exRect = getCardRect(exCode);
      if (!exRect) continue;
      drawLine(svg, activeRect, exRect, 'exclusion');
    }
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
    for (const code of STATE.selectedModules) {
      const mod = STATE.moduleIndex.get(code);
      if (mod && mod.year === year && mod.sectionKey === secKey) {
        total += mod.credits;
      }
    }
    return total;
  }

  function calculateSemesterCredits(year) {
    let sem1 = 0, sem2 = 0;
    for (const code of STATE.selectedModules) {
      const mod = STATE.moduleIndex.get(code);
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

    // Update per-section counters in section headings
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

    // Build summary bar
    const hasSelections = STATE.selectedModules.size > 0;
    container.className = hasSelections ? 'visible' : '';

    if (!hasSelections) {
      container.innerHTML = '';
      return;
    }

    let html = '<div class="credit-row">';

    // Per-year totals
    for (const year of YEARS) {
      let total = 0;
      for (const code of STATE.selectedModules) {
        const mod = STATE.moduleIndex.get(code);
        if (mod && mod.year === year && isModuleVisible(mod, STATE.entryYear)) {
          total += mod.credits;
        }
      }
      if (total > 0) {
        const cls = total === 120 ? 'valid' : total > 120 ? 'warning' : '';
        html += `<span class="credit-item ${cls}"><span class="label">${year}:</span> <span class="value">${total}/120</span></span>`;
      }
    }

    // Semester balance info for Year 3U and 4U
    for (const year of ['Year 3U', 'Year 4U']) {
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
      const code = card.dataset.code;
      const mod = STATE.moduleIndex.get(code);
      if (!mod) return;

      // Search filter
      const query = STATE.searchQuery.toLowerCase();
      const matchesSearch = !query ||
        mod.code.toLowerCase().includes(query) ||
        mod.description.toLowerCase().includes(query);
      card.classList.toggle('search-hidden', !matchesSearch);

      // Period filter
      const matchesPeriod = STATE.periodFilter === 'all' || mod.period === STATE.periodFilter;
      card.classList.toggle('period-hidden', !matchesPeriod);
    });

    // If active module is hidden, clear it
    if (STATE.activeModule) {
      const card = document.querySelector(`[data-code="${STATE.activeModule}"]`);
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
    renderAll();
    saveState();
  }

  function handleToggleDetails() {
    STATE.showDetails = !STATE.showDetails;
    document.querySelectorAll('.card-details').forEach(el => {
      el.classList.toggle('visible', STATE.showDetails);
    });
    const btn = document.getElementById('toggle-details');
    btn.textContent = STATE.showDetails ? 'Hide Details' : 'Details';

    // Redraw lines after layout change
    if (STATE.activeModule) {
      setTimeout(() => drawDependencyLines(STATE.activeModule), 100);
    }
    saveState();
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
      for (const code of STATE.selectedModules) {
        const mod = STATE.moduleIndex.get(code);
        if (mod && mod.year === year) yearMods.push(mod);
      }
      if (yearMods.length === 0) continue;

      const yearNum = parseInt(year.match(/\d/)[0]);
      const academicYear = getAcademicYearLabel(STATE.entryYear, yearNum - 1);
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
      // Fallback: download as file
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

  function showToast(message, type) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type || 'info'}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3500);
  }

  // ===== PERSISTENCE =====

  function saveState() {
    try {
      const data = {
        selectedModules: [...STATE.selectedModules],
        entryYear: STATE.entryYear,
        showDetails: STATE.showDetails,
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
    } catch (e) { /* ignore */ }
  }

  // ===== INIT =====

  function attachEventListeners() {
    document.getElementById('entry-year').addEventListener('change', handleEntryYearChange);
    document.getElementById('search-input').addEventListener('input', handleSearch);
    document.querySelector('.filter-group').addEventListener('click', handlePeriodFilter);
    document.getElementById('toggle-details').addEventListener('click', handleToggleDetails);
    document.getElementById('clear-selection').addEventListener('click', handleClearSelection);
    document.getElementById('export-selection').addEventListener('click', handleExport);
    window.addEventListener('resize', handleResize);

    // Update details button text
    if (STATE.showDetails) {
      document.getElementById('toggle-details').textContent = 'Hide Details';
    }
  }

  async function init() {
    loadState();

    try {
      const resp = await fetch('data/uea_modules_combined.json');
      const raw = await resp.json();
      STATE.modules = raw.modules;
    } catch (e) {
      document.getElementById('module-container').innerHTML =
        '<p style="padding:40px;text-align:center;color:#dc2626;">Failed to load module data. Please run from a local server (e.g. <code>python3 -m http.server</code>).</p>';
      return;
    }

    buildModuleIndex();

    // Init SVG defs
    const svg = document.getElementById('dependency-svg');
    initSVGDefs(svg);

    renderAll();
    attachEventListeners();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

(() => {
  const view = document.querySelector('#view-market');
  if (!view) return;

  const state = {
    windowDays: 90,
    cohort: 'stable_28d',
    granularity: 'week',
    dimension: 'category',
    focus: '',
    evidencePage: 0,
    filterCategory: '', filterSpecialty: '', filterTechnology: '', filterRegion: '', filterCountry: '', filterProvider: '', filterWorkMode: '', filterEmploymentType: ''
  };

  const colors = ['#168052', '#3f78b5', '#d97939', '#8b5fbf', '#bd4d68', '#4f9b92', '#8a6d3b', '#71807a'];
  const dimensionLabels = { category: 'Job categories', specialty: 'Engineering specialties', technology: 'Technologies', region: 'Regions', country: 'Countries' };
  const categoryLabels = { software_engineering: 'Software engineering', it_infrastructure: 'IT / infrastructure', data_analytics: 'Data / analytics', product: 'Product', design: 'Design', sales: 'Sales', marketing: 'Marketing', operations: 'Operations', finance: 'Finance', customer_support: 'Customer support', other: 'Other', unknown: 'Unknown' };
  const facetLabels = { unknown: 'Unknown', worldwide: 'Worldwide', APAC: 'APAC', Asia: 'Asia', Europe: 'Europe', Americas: 'Americas', EMEA: 'EMEA' };

  function today() { return new Date().toISOString().slice(0, 10); }
  function fromDate(days) { const value = new Date(); value.setUTCDate(value.getUTCDate() - days + 1); return value.toISOString().slice(0, 10); }
  function pct(value) { return Math.round(Number(value || 0) * 100) + '%'; }
  function delta(value, type = 'share') { const number = Number(value || 0); return (number >= 0 ? '+' : '') + (type === 'share' ? (number * 100).toFixed(1) + ' pp' : number.toLocaleString()); }
  function label(value, labels = {}) { return labels[value] || categoryLabels[value] || facetLabels[value] || String(value || 'Unknown').replaceAll('_', ' '); }
  function params() {
    const query = new URLSearchParams(location.search);
    state.windowDays = Number(query.get('marketWindow')) || state.windowDays;
    state.cohort = query.get('marketCohort') || state.cohort;
    state.granularity = query.get('marketGranularity') || state.granularity;
    state.dimension = query.get('marketDimension') || state.dimension;
    state.focus = query.get('marketFocus') || '';
    state.filterCategory = query.get('marketFilterCategory') || '';
    state.filterSpecialty = query.get('marketFilterSpecialty') || '';
    state.filterTechnology = query.get('marketFilterTechnology') || '';
    state.filterRegion = query.get('marketFilterRegion') || '';
    state.filterCountry = query.get('marketFilterCountry') || '';
    state.filterProvider = query.get('marketFilterProvider') || '';
    state.filterWorkMode = query.get('marketFilterWorkMode') || '';
    state.filterEmploymentType = query.get('marketFilterEmploymentType') || '';
  }
  function persist() {
    const query = new URLSearchParams(location.search);
    query.delete('marketMode');
    [['marketWindow', state.windowDays], ['marketCohort', state.cohort], ['marketGranularity', state.granularity], ['marketDimension', state.dimension], ['marketFocus', state.focus], ['marketFilterCategory', state.filterCategory], ['marketFilterSpecialty', state.filterSpecialty], ['marketFilterTechnology', state.filterTechnology], ['marketFilterRegion', state.filterRegion], ['marketFilterCountry', state.filterCountry], ['marketFilterProvider', state.filterProvider], ['marketFilterWorkMode', state.filterWorkMode], ['marketFilterEmploymentType', state.filterEmploymentType]].forEach(([key, value]) => value ? query.set(key, String(value)) : query.delete(key));
    history.replaceState(null, '', location.pathname + (query.toString() ? '?' + query.toString() : ''));
  }
  function dashboardQuery() {
    return new URLSearchParams({ from: fromDate(state.windowDays), to: today(), cohort: state.cohort, dimension: state.dimension, granularity: state.granularity });
  }
  function currentQuery() {
    const query = new URLSearchParams({ dimension: state.dimension, active: 'true' });
    [['category', state.filterCategory], ['specialty', state.filterSpecialty], ['technology', state.filterTechnology], ['region', state.filterRegion], ['country', state.filterCountry], ['provider', state.filterProvider], ['workMode', state.filterWorkMode], ['employmentType', state.filterEmploymentType]].forEach(([key, value]) => { if (value) query.set(key, value); });
    return query;
  }
  function hasCurrentFilters() { return Boolean(state.filterCategory || state.filterSpecialty || state.filterTechnology || state.filterRegion || state.filterCountry || state.filterProvider || state.filterWorkMode || state.filterEmploymentType); }
  function evidenceQuery(value) {
    const query = new URLSearchParams({ dimension: state.dimension, value, from: fromDate(state.windowDays), to: today(), limit: '25', offset: String(state.evidencePage * 25) });
    [['category', state.filterCategory], ['specialty', state.filterSpecialty], ['technology', state.filterTechnology], ['region', state.filterRegion], ['country', state.filterCountry], ['provider', state.filterProvider], ['workMode', state.filterWorkMode], ['employmentType', state.filterEmploymentType]].forEach(([key, value]) => { if (value) query.set(key, value); });
    return query;
  }

  view.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">MARKET OBSERVABILITY</p><h1>Market dashboard</h1><p class="subtle">See where observed hiring is concentrated, how sector share changes, and which companies support the movement.</p></div><div class="heading-actions"><button id="market-dashboard-refresh" class="button secondary" type="button">Refresh</button></div></div>
    <div class="market-dashboard-controls"><div class="filters"><label>Window<select id="market-dashboard-window"><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option></select></label><label>Cohort<select id="market-dashboard-cohort"><option value="stable_28d">Stable 28-day cohort</option><option value="all">All observed boards</option></select></label><label>Granularity<select id="market-dashboard-granularity"><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option></select></label><label>Dimension<select id="market-dashboard-dimension"><option value="category">Job categories</option><option value="specialty">Engineering specialties</option><option value="technology">Technologies</option><option value="region">Regions</option><option value="country">Countries</option></select></label></div><div class="heading-actions"><button id="market-dashboard-advanced-toggle" class="button secondary" type="button">More filters</button><button id="market-dashboard-clear-filters" class="button secondary filter-clear" type="button">Clear filters</button></div></div>
    <div id="market-dashboard-advanced" class="market-dashboard-advanced hidden"><span class="subtle">These filters affect evidence drill-downs, not historical cohort calculations.</span><select id="market-dashboard-provider"><option value="">Any ATS provider</option><option value="greenhouse">Greenhouse</option><option value="ashby">Ashby</option><option value="lever">Lever</option><option value="remotive">Remotive</option><option value="adzuna">Adzuna</option></select><select id="market-dashboard-work-mode"><option value="">Any work mode</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option><option value="unknown">Unknown</option></select><select id="market-dashboard-employment"><option value="">Any employment type</option><option value="full">Full-time</option><option value="contract">Contract</option><option value="freelance">Freelance</option></select></div>
    <div id="market-dashboard-stats" class="stats market-dashboard-stats"></div>
    <div id="market-dashboard-coverage" class="market-dashboard-coverage subtle"></div>
    <div id="market-dashboard-loading" class="empty hidden"><p>Loading market snapshots…</p></div>
    <div id="market-dashboard-content">
      <div class="market-dashboard-chart-grid"><div class="market-panel market-chart-panel"><div class="company-panel-heading"><div><h2 id="market-volume-title">Observed volume</h2><p class="subtle">Active observed openings over time.</p></div></div><div id="market-volume-chart"></div></div><div class="market-panel market-chart-panel"><div class="company-panel-heading"><div><h2 id="market-share-title">Observed share</h2><p class="subtle">Each period totals 100% of the selected cohort.</p></div></div><div id="market-share-chart"></div></div></div>
      <div class="market-panel market-chart-panel"><div class="company-panel-heading"><div><h2>Opening flow</h2><p class="subtle">New and removed observed openings by period.</p></div></div><div id="market-flow-chart"></div></div>
      <div class="market-panel"><div class="company-panel-heading"><div><h2 id="market-ranking-title">Current mix</h2><p class="subtle">Click a value to focus the charts, or open its evidence.</p></div></div><div id="market-rankings"></div></div>
      <div class="market-panel"><h2>Market signals</h2><div id="market-dashboard-signals"><p class="subtle">No sufficiently supported signals yet.</p></div></div>
      <details class="market-panel market-analysis-tools"><summary>Analysis tools</summary><div class="segment-grid"><label>Segment A<select id="market-compare-a"><option value="">Choose category</option></select></label><label>Segment B<select id="market-compare-b"><option value="">Choose category</option></select></label><label>Work mode<select id="market-compare-work-mode"><option value="">Any work mode</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option></select></label><label>Employment<select id="market-compare-employment"><option value="">Any employment type</option><option value="full">Full-time</option><option value="contract">Contract</option><option value="freelance">Freelance</option></select></label></div><button id="market-compare-button" class="button secondary" type="button">Compare segments</button><div id="market-comparison" class="comparison-grid"><p class="subtle">Choose two categories to compare.</p></div><div class="market-taxonomy-tools"><h3>Technology taxonomy</h3><form id="market-taxonomy-form" class="filters"><input name="canonical" placeholder="Canonical technology" required><input name="alias" placeholder="Alias" required><button class="button secondary" type="submit">Add alias</button></form><div id="market-taxonomy" class="facet-list"></div></div></details>
    </div>
    <div id="market-evidence" class="market-evidence-modal hidden" role="dialog" aria-modal="true" aria-labelledby="market-evidence-title"><div class="market-evidence-backdrop" data-close-market-evidence></div><section class="market-evidence-dialog"><div class="company-panel-heading"><div><p class="eyebrow">EVIDENCE</p><h2 id="market-evidence-title">Supporting data</h2><p id="market-evidence-note" class="subtle"></p></div><div class="heading-actions"><button id="market-evidence-open-listings" class="button primary hidden" type="button">Open matching listings</button><button id="market-evidence-close" class="button secondary" type="button">Close</button></div></div><div id="market-evidence-companies"></div><div id="market-evidence-listings"></div><div id="market-evidence-pagination" class="pagination"></div></section></div>
  `;

  function ensureDashboardFilterControls() {
    const advanced = document.querySelector('#market-dashboard-advanced');
    if (!advanced || document.querySelector('#market-dashboard-filter-category')) return;
    advanced.insertAdjacentHTML('beforeend', '<select id="market-dashboard-filter-category"><option value="">Any category</option></select><select id="market-dashboard-filter-specialty"><option value="">Any specialty</option></select><select id="market-dashboard-filter-technology"><option value="">Any technology</option></select><select id="market-dashboard-filter-region"><option value="">Any region</option></select><select id="market-dashboard-filter-country"><option value="">Any country</option></select>');
  }
  ensureDashboardFilterControls();
  const filterNote = document.querySelector('#market-dashboard-advanced .subtle');
  if (filterNote) filterNote.textContent = 'Selecting filters switches the charts to a current live view; window and cohort history controls apply when filters are cleared.';

  function setControls() {
    document.querySelector('#market-dashboard-window').value = String(state.windowDays);
    document.querySelector('#market-dashboard-cohort').value = state.cohort;
    document.querySelector('#market-dashboard-granularity').value = state.granularity;
    document.querySelector('#market-dashboard-dimension').value = state.dimension;
    document.querySelector('#market-dashboard-filter-category').value = state.filterCategory;
    document.querySelector('#market-dashboard-filter-specialty').value = state.filterSpecialty;
    document.querySelector('#market-dashboard-filter-technology').value = state.filterTechnology;
    document.querySelector('#market-dashboard-filter-region').value = state.filterRegion;
    document.querySelector('#market-dashboard-filter-country').value = state.filterCountry;
    document.querySelector('#market-dashboard-provider').value = state.filterProvider;
    document.querySelector('#market-dashboard-work-mode').value = state.filterWorkMode;
    document.querySelector('#market-dashboard-employment').value = state.filterEmploymentType;
  }

  function statMarkup(labelText, value, detail = '') {
    return '<div class="stat"><span>' + esc(labelText) + '</span><strong>' + esc(String(value)) + '</strong>' + (detail ? '<small class="subtle">' + esc(detail) + '</small>' : '') + '</div>';
  }

  function groupSeries(data) {
    const periods = [...new Set((data.series || []).map((row) => row.snapshot_date))].sort();
    const keyTotals = new Map();
    (data.series || []).forEach((row) => keyTotals.set(row.dimension_value, (keyTotals.get(row.dimension_value) || 0) + Number(row.active_listings || 0)));
    const keys = [...keyTotals.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 8).map(([key]) => key);
    const rows = periods.map((period) => {
      const values = new Map((data.series || []).filter((row) => row.snapshot_date === period).map((row) => [row.dimension_value, row]));
      const total = [...values.values()].reduce((sum, row) => sum + Number(row.active_listings || 0), 0);
      return { period, values, total };
    });
    const hasRemaining = rows.some((entry) => entry.total > keys.reduce((sum, key) => sum + Number(entry.values.get(key)?.active_listings || 0), 0));
    const selected = state.focus && keys.includes(state.focus) ? state.focus : '';
    rows.forEach((entry) => { entry.chartKeys = selected ? [selected, ...(hasRemaining ? ['__remaining'] : [])] : [...keys, ...(hasRemaining ? ['__remaining'] : [])]; });
    return { periods, keys, rows };
  }

  function chartSvg(data, field, title) {
    const grouped = groupSeries(data);
    if (!grouped.rows.length) return '<p class="subtle">No snapshots are available for this period and cohort yet.</p>';
    const width = 900, height = 285, left = 42, right = 16, top = 18, bottom = 34;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const totalSeries = new Map((data.total_series || []).map((row) => [row.snapshot_date, Number(row.active_listings || 0)]));
    const observedTotal = (entry) => totalSeries.get(entry.period) || 0;
    const valuesFor = (entry, key) => {
      if (key === '__remaining') {
        const known = entry.chartKeys.filter((item) => item !== '__remaining').reduce((sum, item) => sum + Number(entry.values.get(item)?.active_listings || 0), 0);
        return Math.max(0, entry.total - known);
      }
      return Number(entry.values.get(key)?.active_listings || 0);
    };
    const maxValue = Math.max(1, ...grouped.rows.map((entry) => Math.max(entry.total, observedTotal(entry))));
    const denominator = field === 'share' ? 1 : maxValue;
    const x = (index) => left + (grouped.rows.length < 2 ? plotWidth / 2 : (index / (grouped.rows.length - 1)) * plotWidth);
    const y = (value) => top + plotHeight - (value / denominator) * plotHeight;
    let cumulative = grouped.rows.map(() => 0);
    const paths = grouped.rows.length ? grouped.rows[0].chartKeys.map((key, seriesIndex) => {
      const bottoms = grouped.rows.map((entry, index) => {
        const raw = valuesFor(entry, key);
        const value = field === 'share' ? (entry.total ? raw / entry.total : 0) : raw;
        return cumulative[index] += value;
      });
      const tops = bottoms.map((value, index) => y(value));
      const bottomValues = grouped.rows.map((entry, index) => {
        const raw = valuesFor(entry, key);
        const value = field === 'share' ? (entry.total ? raw / entry.total : 0) : raw;
        return cumulative[index] - value;
      });
      const path = 'M ' + grouped.rows.map((entry, index) => x(index) + ' ' + tops[index]).join(' L ') + ' L ' + grouped.rows.map((entry, index) => x(grouped.rows.length - 1 - index) + ' ' + y(bottomValues[grouped.rows.length - 1 - index])).join(' L ') + ' Z';
      const sector = esc(key);
      const shape = grouped.rows.length === 1
        ? '<rect class="chart-sector" data-sector="' + sector + '" x="' + left + '" y="' + tops[0] + '" width="' + plotWidth + '" height="' + Math.max(2, y(bottomValues[0]) - tops[0]) + '" fill="' + colors[seriesIndex % colors.length] + '" opacity=".82">'
        : '<path class="chart-sector" data-sector="' + sector + '" d="' + path + '" fill="' + colors[seriesIndex % colors.length] + '" opacity=".82">';
      return shape + '<title>' + esc(label(key === '__remaining' ? 'Remaining' : key)) + '</title>' + (grouped.rows.length === 1 ? '</rect>' : '</path>');
    }).join('') : '';
    const totalPoints = grouped.rows.map((entry, index) => x(index) + ' ' + y(observedTotal(entry))).join(' L ');
    const totalLine = field === 'volume' && grouped.rows.some((entry) => observedTotal(entry) > 0)
      ? (grouped.rows.length === 1 ? '<circle cx="' + x(0) + '" cy="' + y(observedTotal(grouped.rows[0])) + '" r="4" class="market-total-point"></circle>' : '<path d="M ' + totalPoints + '" fill="none" class="market-total-line"></path>')
      : '';
    const hoverPoints = grouped.rows.map((entry, index) => {
      let stack = 0;
      return entry.chartKeys.map((key) => {
        const raw = valuesFor(entry, key);
        const value = field === 'share' ? (entry.total ? raw / entry.total : 0) : raw;
        stack += value;
        return '<circle cx="' + x(index) + '" cy="' + y(stack) + '" r="7" class="chart-point" data-sector="' + esc(key) + '" data-tooltip="' + esc(String(entry.period).slice(0, 10) + ' · ' + label(key === '__remaining' ? 'Remaining' : key) + ' · ' + (field === 'share' ? (value * 100).toFixed(1) + '%' : raw.toLocaleString())) + '"><title>' + esc(String(entry.period).slice(0, 10)) + ' · ' + esc(label(key === '__remaining' ? 'Remaining' : key)) + ' · ' + (field === 'share' ? (value * 100).toFixed(1) + '%' : raw.toLocaleString()) + '</title></circle>';
      }).join('');
    }).join('');
    const periodHoverZones = grouped.rows.map((entry, index) => {
      const step = grouped.rows.length < 2 ? plotWidth : plotWidth / (grouped.rows.length - 1);
      const zoneX = grouped.rows.length < 2 ? left : Math.max(left, x(index) - step / 2);
      const zoneWidth = grouped.rows.length < 2 ? plotWidth : Math.min(step, width - right - zoneX);
      const lines = [String(entry.period).slice(0, 10)];
      let stack = 0;
      const segments = [];
      if (field === 'volume' && observedTotal(entry) > 0) lines.push('Total observed: ' + observedTotal(entry).toLocaleString());
      entry.chartKeys.forEach((key) => {
        const raw = valuesFor(entry, key);
        const value = field === 'share' ? (entry.total ? raw / entry.total : 0) : raw;
        segments.push({ key, top: y(stack + value), bottom: y(stack) });
        stack += value;
        if (raw > 0) lines.push(label(key === '__remaining' ? 'Remaining' : key) + ': ' + (field === 'share' ? (value * 100).toFixed(1) + '%' : raw.toLocaleString()));
      });
      return '<rect x="' + zoneX + '" y="' + top + '" width="' + zoneWidth + '" height="' + plotHeight + '" class="period-hover-zone" data-segments="' + esc(JSON.stringify(segments)) + '" data-tooltip="' + esc(lines.join('\n')) + '"></rect>';
    }).join('');
    const labels = grouped.rows.filter((entry, index) => index === 0 || index === grouped.rows.length - 1 || index % Math.max(1, Math.floor(grouped.rows.length / 4)) === 0).map((entry) => {
      const index = grouped.periods.indexOf(entry.period);
      return '<text x="' + x(index) + '" y="' + (height - 10) + '" text-anchor="middle">' + esc(String(entry.period).slice(0, 10)) + '</text>';
    }).join('');
    const legendKeys = grouped.rows[0]?.chartKeys || [];
    const legend = legendKeys.map((key, index) => '<button type="button" class="market-sector-key ' + (state.focus === key ? 'selected' : '') + '" data-sector="' + esc(key) + '"><i style="background:' + colors[index % colors.length] + '"></i>' + esc(label(key === '__remaining' ? 'Remaining' : key)) + '</button>').join('') + (field === 'volume' && totalLine ? '<span class="market-total-key"><i></i>Total observed</span>' : '');
    return '<div class="market-chart"><svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(title) + '"><line x1="' + left + '" x2="' + (width - right) + '" y1="' + (top + plotHeight) + '" y2="' + (top + plotHeight) + '" class="chart-axis"></line><line x1="' + left + '" x2="' + (width - right) + '" y1="' + top + '" y2="' + top + '" class="chart-gridline"></line>' + paths + totalLine + periodHoverZones + hoverPoints + labels + '</svg><div class="market-chart-legend">' + legend + '</div></div>';
  }

  function flowSvg(data) {
    const grouped = groupSeries(data);
    if (!grouped.rows.length) return '<p class="subtle">No snapshot flow is available for this period and cohort yet.</p>';
    const width = 900, height = 230, left = 42, right = 16, top = 18, bottom = 34;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const maxValue = Math.max(1, ...grouped.rows.map((entry) => [...entry.values.values()].reduce((sum, row) => sum + Number(row.new_listings || 0) + Number(row.removed_listings || 0), 0)));
    const slotWidth = plotWidth / Math.max(1, grouped.rows.length);
    const barWidth = Math.max(4, Math.min(32, slotWidth * .7));
    const hasFlow = grouped.rows.some((entry) => [...entry.values.values()].some((row) => Number(row.new_listings || 0) > 0 || Number(row.removed_listings || 0) > 0));
    const bars = grouped.rows.map((entry, index) => {
      const added = [...entry.values.values()].reduce((sum, row) => sum + Number(row.new_listings || 0), 0);
      const removed = [...entry.values.values()].reduce((sum, row) => sum + Number(row.removed_listings || 0), 0);
      const scale = (plotHeight / 2) / maxValue;
      const x = left + slotWidth * (index + .5);
      const addedHeight = added * scale, removedHeight = removed * scale;
      return '<rect x="' + (x - barWidth / 2) + '" y="' + (top + plotHeight / 2 - addedHeight) + '" width="' + (barWidth / 2 - 1) + '" height="' + addedHeight + '" class="flow-new chart-hover-target" data-tooltip="' + esc('New observed: +' + added.toLocaleString()) + '"><title>' + esc(entry.period) + ': +' + added.toLocaleString() + ' new</title></rect><rect x="' + (x + 1) + '" y="' + (top + plotHeight / 2) + '" width="' + (barWidth / 2 - 1) + '" height="' + removedHeight + '" class="flow-removed chart-hover-target" data-tooltip="' + esc('Removed observed: ' + removed.toLocaleString()) + '"><title>' + esc(entry.period) + ': ' + removed.toLocaleString() + ' removed</title></rect>';
    }).join('');
    const labels = grouped.rows.filter((entry, index) => index === 0 || index === grouped.rows.length - 1 || index % Math.max(1, Math.floor(grouped.rows.length / 4)) === 0).map((entry) => {
      const index = grouped.periods.indexOf(entry.period);
      const x = left + slotWidth * (index + .5);
      return '<text x="' + x + '" y="' + (height - 10) + '" text-anchor="middle">' + esc(String(entry.period).slice(0, 10)) + '</text>';
    }).join('');
    return '<div class="market-chart"><svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="New and removed openings"><line x1="' + left + '" x2="' + (width - right) + '" y1="' + (top + plotHeight / 2) + '" y2="' + (top + plotHeight / 2) + '" class="chart-axis"></line>' + bars + (hasFlow ? '' : '<text x="' + (width / 2) + '" y="' + (top + plotHeight / 2 - 8) + '" text-anchor="middle">No new or removed openings recorded</text>') + labels + '</svg><div class="market-flow-legend"><span><i class="flow-new-swatch"></i>New observed</span><span><i class="flow-removed-swatch"></i>Removed observed</span></div></div>';
  }

  function renderRankings(data) {
    const rows = (data.rankings || []).slice(0, 20);
    const dimensionLabel = label(data.dimension, dimensionLabels);
    document.querySelector('#market-ranking-title').textContent = dimensionLabel + ' mix';
    document.querySelector('#market-rankings').innerHTML = rows.length ? '<div class="market-ranking-header"><span>' + esc(dimensionLabel) + '</span><span>Active</span><span>Share</span><span>New</span><span>Change</span><span></span></div>' + rows.map((row) => '<div class="market-ranking-row ' + (state.focus === row.dimension_value ? 'selected' : '') + '"><button type="button" class="market-ranking-sector market-sector-key" data-sector="' + esc(row.dimension_value) + '">' + esc(label(row.dimension_value)) + '</button><span>' + Number(row.active_listings).toLocaleString() + '</span><span>' + pct(row.active_share) + '</span><span>+' + Number(row.new_listings).toLocaleString() + '</span><span class="' + (row.share_delta >= 0 ? 'positive' : 'negative') + '">' + delta(row.share_delta) + '</span><button type="button" class="button secondary market-evidence-button" data-sector="' + esc(row.dimension_value) + '">Evidence</button></div>').join('') : '<p class="subtle">No snapshots are available for this view yet.</p>';
  }

  function renderSignals(data) {
    document.querySelector('#market-dashboard-signals').innerHTML = (data.signals || []).length ? data.signals.slice(0, 8).map((signal) => '<div class="signal-row"><div><strong>' + esc(signal.employer_name || (signal.dimension ? 'Market · ' + signal.dimension : 'Market')) + '</strong><div class="subtle">' + esc(signal.explanation) + '</div><div class="health-detail">' + esc(String(signal.signal_type).replaceAll('_', ' ')) + ' · ' + Number(signal.sample_size || 0).toLocaleString() + ' baseline days</div></div><button type="button" class="button secondary market-signal-evidence-button" data-signal-id="' + esc(signal.id) + '">Evidence</button></div>').join('') : '<p class="subtle">No sufficiently supported signals yet.</p>';
  }

  function openListingsForDimension(value) {
    const filterId = { category: '#listing-category', specialty: '#listing-specialty', technology: '#listing-technology', region: '#listing-region', country: '#listing-country' }[state.dimension];
    if (!filterId || value === '__remaining' || typeof showView !== 'function' || typeof loadListings !== 'function') return;
    const values = {
      '#listing-category': state.filterCategory,
      '#listing-specialty': state.filterSpecialty,
      '#listing-technology': state.filterTechnology,
      '#listing-region': state.filterRegion,
      '#listing-country': state.filterCountry,
      '#listing-provider': state.filterProvider,
      '#listing-work-mode': state.filterWorkMode,
      '#listing-employment-type': state.filterEmploymentType
    };
    values[filterId] = value;
    Object.entries(values).forEach(([id, selectedValue]) => {
      const select = document.querySelector(id);
      if (!select) return;
      if (selectedValue && ![...select.options].some((option) => option.value === selectedValue)) select.add(new Option(label(selectedValue), selectedValue));
      select.value = selectedValue || '';
    });
    showView('listings');
    const select = document.querySelector(filterId);
    if (!select) return;
    if (![...select.options].some((option) => option.value === value)) select.add(new Option(label(value), value));
    select.value = value;
    document.querySelector('#market-evidence')?.classList.add('hidden');
    document.body.classList.remove('market-evidence-open');
    loadListings(true).catch(console.error);
  }

  async function openSignalEvidence(id) {
    const data = await api('/api/market/signals/' + encodeURIComponent(id));
    const panel = document.querySelector('#market-evidence');
    panel.classList.remove('hidden');
    document.body.classList.add('market-evidence-open');
    document.querySelector('#market-evidence-title').textContent = 'Signal evidence';
    document.querySelector('#market-evidence-open-listings').classList.add('hidden');
    document.querySelector('#market-evidence-note').textContent = data.signal?.explanation || 'Listings and companies supporting this signal.';
    document.querySelector('#market-evidence-companies').innerHTML = '<h3>Contributing employers</h3>' + ((data.companies || []).length ? data.companies.map((company) => '<div class="health-row"><a class="source-link market-evidence-company" href="#" data-company-id="' + esc(company.id) + '">' + esc(company.name) + '</a></div>').join('') : '<p class="subtle">No company evidence recorded.</p>');
    document.querySelector('#market-evidence-listings').innerHTML = '<h3>Supporting listings</h3>' + ((data.evidence || []).length ? data.evidence.map((listing) => '<div class="market-evidence-listing"><div><strong>' + esc(listing.title) + '</strong><div class="subtle">' + esc(listing.employer_name) + ' · ' + esc(listing.provider) + ' · ' + esc(listing.location || 'Location unknown') + '</div></div><a class="source-link" href="' + esc(listing.application_url || listing.original_url || '#') + '" target="_blank" rel="noreferrer">Source ↗</a></div>').join('') : '<p class="subtle">No listing evidence recorded.</p>');
    document.querySelector('#market-evidence-pagination').innerHTML = '';
    document.querySelectorAll('.market-evidence-company').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); openCompanyFromEvidence(link.dataset.companyId).catch(console.error); }));
  }

  function render(data, currentData = null) {
    const viewData = currentData || data;
    const isFiltered = Boolean(currentData);
    const summary = viewData.summary || {};
    document.querySelector('#market-dashboard-stats').innerHTML = [
      statMarkup('Active openings', Number(summary.active_listings || 0).toLocaleString(), delta(summary.active_delta, 'count') + ' vs prior period'),
      statMarkup('New openings', '+' + Number(summary.new_listings || 0).toLocaleString(), 'observed in selected window'),
      statMarkup('Active employers', Number(summary.employers || 0).toLocaleString()),
      statMarkup('Remote share', pct(summary.remote_share)),
      statMarkup('Contract share', pct(summary.contract_share)),
      statMarkup(isFiltered ? 'Filtered openings' : 'Stable coverage', isFiltered ? Number(summary.active_listings || 0).toLocaleString() : Number(viewData.coverage?.stable_boards || 0).toLocaleString() + ' boards', isFiltered ? 'current listings matching filters' : Number(viewData.coverage?.monitored_boards || 0).toLocaleString() + ' monitored')
    ].join('');
    const categoryNote = viewData.dimension === 'category' ? ' · Unknown = no usable classification text; Other = text did not match the current taxonomy' : '';
    document.querySelector('#market-dashboard-coverage').textContent = isFiltered ? 'Current filtered view · ' + Number(summary.active_listings || 0).toLocaleString() + ' active listings match the selected filters · historical snapshots are not filtered.' : (viewData.cohort === 'stable_28d' ? 'Stable cohort' : 'All observed boards') + ' · ' + viewData.from + ' → ' + viewData.to + ' · ' + Number(viewData.coverage?.snapshots || 0).toLocaleString() + ' snapshots · ' + (viewData.coverage?.coverage_note || 'Coverage note unavailable') + categoryNote;
    const shareNote = document.querySelectorAll('.market-chart-panel .subtle')[1];
    if (shareNote) shareNote.textContent = viewData.dimension === 'category' ? 'Each period totals 100% of the selected cohort.' : 'Relative share of classified observations; multi-label listings may overlap.';
    const volumeNote = document.querySelectorAll('.market-chart-panel .subtle')[0];
    if (volumeNote) volumeNote.textContent = isFiltered ? 'Current active openings matching the selected filters.' : 'Active observed openings over time.';
    const dimensionLabel = label(viewData.dimension, dimensionLabels);
    document.querySelector('#market-volume-title').textContent = dimensionLabel + ' volume';
    document.querySelector('#market-share-title').textContent = dimensionLabel + ' share';
    document.querySelector('#market-volume-chart').innerHTML = chartSvg(viewData, 'volume', dimensionLabel + ' volume over time');
    document.querySelector('#market-share-chart').innerHTML = chartSvg(viewData, 'share', dimensionLabel + ' share over time');
    document.querySelector('#market-flow-chart').innerHTML = isFiltered ? '<p class="subtle">Opening flow is available for the unfiltered historical view. Clear filters to compare new and removed openings over time.</p>' : flowSvg(viewData);
    renderRankings(viewData);
    renderSignals(data);
    bindChartTooltips();
    document.querySelectorAll('.market-sector-key').forEach((button) => button.addEventListener('click', () => { state.focus = state.focus === button.dataset.sector ? '' : button.dataset.sector; persist(); render(data, currentData); }));
    document.querySelectorAll('.chart-sector').forEach((sector) => sector.addEventListener('click', () => openListingsForDimension(sector.dataset.sector)));
    document.querySelectorAll('.chart-point').forEach((point) => point.addEventListener('click', () => openListingsForDimension(point.dataset.sector)));
    document.querySelectorAll('.period-hover-zone').forEach((zone) => zone.addEventListener('click', (event) => {
      const svg = zone.ownerSVGElement;
      const transform = svg?.getScreenCTM();
      if (!transform) return;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const local = point.matrixTransform(transform.inverse());
      const segment = JSON.parse(zone.dataset.segments || '[]').find((item) => local.y >= item.top && local.y <= item.bottom);
      if (segment) openListingsForDimension(segment.key);
    }));
    document.querySelectorAll('.market-evidence-button').forEach((button) => button.addEventListener('click', () => openEvidence(button.dataset.sector)));
    document.querySelectorAll('.market-signal-evidence-button').forEach((button) => button.addEventListener('click', () => openSignalEvidence(button.dataset.signalId).catch(console.error)));
  }

  function bindChartTooltips() {
    document.querySelectorAll('.market-chart').forEach((chart) => {
      let tooltip = chart.querySelector('.market-chart-tooltip');
      if (!tooltip) {
        chart.insertAdjacentHTML('beforeend', '<div class="market-chart-tooltip" role="status"></div>');
        tooltip = chart.querySelector('.market-chart-tooltip');
      }
      chart.querySelectorAll('[data-tooltip]').forEach((target) => {
        target.addEventListener('mouseenter', () => { tooltip.textContent = target.dataset.tooltip; tooltip.classList.add('visible'); });
        target.addEventListener('mousemove', (event) => {
          const bounds = chart.getBoundingClientRect();
          tooltip.style.left = Math.max(8, Math.min(event.clientX - bounds.left + 12, bounds.width - tooltip.offsetWidth - 8)) + 'px';
          tooltip.style.top = Math.max(8, event.clientY - bounds.top - tooltip.offsetHeight - 10) + 'px';
        });
        target.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
      });
    });
  }

  function setDashboardFilterOptions(selector, items, labels = {}, placeholder) {
    const select = document.querySelector(selector);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">' + placeholder + '</option>' + (items || []).map((item) => '<option value="' + esc(item.value) + '">' + esc(labels[item.value] || item.value) + ' · ' + Number(item.count).toLocaleString() + '</option>').join('');
    const selected = selector.includes('category') ? state.filterCategory : selector.includes('specialty') ? state.filterSpecialty : selector.includes('technology') ? state.filterTechnology : selector.includes('region') ? state.filterRegion : state.filterCountry;
    if (selected && !(items || []).some((item) => item.value === selected)) select.add(new Option(label(selected), selected));
    select.value = selected || current;
  }

  async function loadDashboardFilterOptions() {
    const data = await api('/api/market/summary?active=true&limit=1');
    const facets = data.facets || {};
    setDashboardFilterOptions('#market-dashboard-filter-category', facets.categories, categoryLabels, 'Any category');
    setDashboardFilterOptions('#market-dashboard-filter-specialty', facets.specialties, {}, 'Any specialty');
    setDashboardFilterOptions('#market-dashboard-filter-technology', facets.technologies, {}, 'Any technology');
    setDashboardFilterOptions('#market-dashboard-filter-region', facets.regions, {}, 'Any region');
    setDashboardFilterOptions('#market-dashboard-filter-country', facets.countries, {}, 'Any country');
  }

  async function loadDashboard() {
    persist();
    const loading = document.querySelector('#market-dashboard-loading');
    loading.classList.remove('hidden');
    try {
      const data = await api('/api/market/dashboard?' + dashboardQuery().toString());
      const currentData = hasCurrentFilters() ? await api('/api/market/current?' + currentQuery().toString()) : null;
      render(data, currentData);
      await Promise.all([loadTaxonomy(), loadDashboardFilterOptions()]);
    } catch (error) {
      document.querySelector('#market-dashboard-content').innerHTML = '<div class="empty"><p>' + esc(error.message) + '</p></div>';
    } finally {
      loading.classList.add('hidden');
    }
  }

  async function openEvidence(value) {
    state.focus = value;
    state.evidencePage = 0;
    persist();
    await loadEvidence();
  }

  async function loadEvidence() {
    const value = state.focus;
    if (!value) return;
    const panel = document.querySelector('#market-evidence');
    panel.classList.remove('hidden');
    document.body.classList.add('market-evidence-open');
    document.querySelector('#market-evidence-title').textContent = label(value) + ' evidence';
    document.querySelector('#market-evidence-note').textContent = 'Current evidence matching the selected sector and period.';
    const openListingsButton = document.querySelector('#market-evidence-open-listings');
    openListingsButton.classList.toggle('hidden', !['category', 'specialty', 'technology', 'region', 'country'].includes(state.dimension) || value === '__remaining');
    try {
      const data = await api('/api/market/drilldown?' + evidenceQuery(value).toString());
      document.querySelector('#market-evidence-companies').innerHTML = '<h3>Contributing employers</h3>' + ((data.companies || []).length ? data.companies.map((company) => '<div class="health-row"><a class="source-link market-evidence-company" href="#" data-company-id="' + esc(company.employer_id) + '">' + esc(company.employer_name) + '</a><span>' + Number(company.listings || 0).toLocaleString() + ' listings · ' + Number(company.engineering || 0).toLocaleString() + ' engineering</span></div>').join('') : '<p class="subtle">No employers match this evidence view.</p>');
      document.querySelector('#market-evidence-listings').innerHTML = '<h3>Supporting listings</h3>' + ((data.evidence || []).length ? data.evidence.map((listing) => '<div class="market-evidence-listing"><div><strong>' + esc(listing.title) + '</strong><div class="subtle">' + esc(listing.employer_name) + ' · ' + esc(listing.provider) + ' · ' + esc(listing.location || 'Location unknown') + '</div></div><a class="source-link" href="' + esc(listing.application_url || listing.original_url || '#') + '" target="_blank" rel="noreferrer">Source ↗</a></div>').join('') : '<p class="subtle">No listings match this evidence view.</p>');
      document.querySelector('#market-evidence-pagination').innerHTML = '<span class="subtle">' + Number(data.evidence?.length || 0).toLocaleString() + ' shown</span><div><button id="market-evidence-prev" class="button secondary" type="button" ' + (state.evidencePage < 1 ? 'disabled' : '') + '>Previous</button><button id="market-evidence-next" class="button secondary" type="button" ' + ((data.evidence || []).length < 25 ? 'disabled' : '') + '>Next</button></div>';
      document.querySelectorAll('.market-evidence-company').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); openCompanyFromEvidence(link.dataset.companyId).catch(console.error); }));
      document.querySelector('#market-evidence-prev').addEventListener('click', () => { state.evidencePage -= 1; loadEvidence().catch(console.error); });
      document.querySelector('#market-evidence-next').addEventListener('click', () => { state.evidencePage += 1; loadEvidence().catch(console.error); });
    } catch (error) {
      document.querySelector('#market-evidence-listings').innerHTML = '<p class="subtle">' + esc(error.message) + '</p>';
    }
  }

  async function loadTaxonomy() {
    try {
      const data = await api('/api/market/taxonomy/technologies');
      document.querySelector('#market-taxonomy').innerHTML = (data.terms || []).slice(0, 40).map((term) => '<div class="health-row"><span>' + esc(term.canonical) + ' · ' + esc(term.alias) + '</span><span class="subtle">' + (term.enabled === false ? 'disabled' : 'enabled') + '</span></div>').join('') || '<p class="subtle">No taxonomy terms configured.</p>';
    } catch (error) {
      document.querySelector('#market-taxonomy').innerHTML = '<p class="subtle">' + esc(error.message) + '</p>';
    }
  }

  params();
  setControls();
  document.querySelector('#market-dashboard-refresh').addEventListener('click', () => loadDashboard().catch(console.error));
  ['window', 'cohort', 'granularity', 'dimension'].forEach((name) => document.querySelector('#market-dashboard-' + name).addEventListener('change', (event) => { closeEvidence(); state[name === 'window' ? 'windowDays' : name] = name === 'window' ? Number(event.target.value) : event.target.value; state.focus = ''; state.evidencePage = 0; loadDashboard().catch(console.error); }));
  [['filter-category', 'filterCategory'], ['filter-specialty', 'filterSpecialty'], ['filter-technology', 'filterTechnology'], ['filter-region', 'filterRegion'], ['filter-country', 'filterCountry'], ['provider', 'filterProvider'], ['work-mode', 'filterWorkMode'], ['employment', 'filterEmploymentType']].forEach(([id, key]) => document.querySelector('#market-dashboard-' + id).addEventListener('change', (event) => { closeEvidence(); state[key] = event.target.value; state.focus = ''; state.evidencePage = 0; loadDashboard().catch(console.error); }));
  document.querySelector('#market-dashboard-advanced-toggle').addEventListener('click', () => document.querySelector('#market-dashboard-advanced').classList.toggle('hidden'));
  document.querySelector('#market-dashboard-clear-filters').addEventListener('click', () => { state.filterCategory = ''; state.filterSpecialty = ''; state.filterTechnology = ''; state.filterRegion = ''; state.filterCountry = ''; state.filterProvider = ''; state.filterWorkMode = ''; state.filterEmploymentType = ''; state.focus = ''; state.evidencePage = 0; setControls(); loadDashboard().catch(console.error); });
  function closeEvidence() {
    state.focus = '';
    persist();
    document.querySelector('#market-evidence').classList.add('hidden');
    document.body.classList.remove('market-evidence-open');
  }
  function openCompanyFromEvidence(id) { closeEvidence(); return openCompany(id); }
  document.querySelector('#market-evidence-close').addEventListener('click', closeEvidence);
  document.querySelector('[data-close-market-evidence]').addEventListener('click', closeEvidence);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !document.querySelector('#market-evidence').classList.contains('hidden')) closeEvidence(); });
  document.querySelector('#market-evidence-open-listings').addEventListener('click', () => openListingsForDimension(state.focus));
  document.querySelector('#market-compare-button').addEventListener('click', () => loadMarketComparison().catch(console.error));
  document.querySelector('#market-taxonomy-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await api('/api/market/taxonomy/technologies', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(form.entries())) }); event.currentTarget.reset(); await loadTaxonomy(); });
  const originalMarketLoad = loadMarket;
  loadMarket = loadDashboard;
  loadDashboard().catch(console.error);
})();

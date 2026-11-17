import type { Analysis, AuthorSignals, ContactMethod, DetectionRule, LocationFit, LocationSignals, NormalizedPost, Preferences, ScoreContribution, SignalCategory } from './types.js';

export function stableOpportunityKey(source: string, sourceId: string): string { return `${source}:${sourceId}`; }
export function detectionLatencyMs(publishedAt: Date, firstSeenAt: Date): number { return Math.max(0, firstSeenAt.getTime() - publishedAt.getTime()); }

export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return escaped.length > 0 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}
function matchingTerms(text: string, terms: string[]): string[] { return terms.filter((term) => containsTerm(text, term)); }
function ruleMatches(text: string, rule: DetectionRule): boolean { try { return rule.match_type === 'regex' ? new RegExp(rule.pattern, 'iu').test(text) : containsTerm(text, rule.pattern); } catch { return false; } }
function addContribution(list: ScoreContribution[], label: string, points: number, evidence: string[]) { if (points > 0) list.push({ label, points, evidence }); }

export function extractOutboundDomains(text: string): string[] {
  const domains = new Set<string>();
  for (const raw of text.match(/https?:\/\/[^\s)]+/gi) ?? []) { try { domains.add(new URL(raw.replace(/[.,!?]+$/, '')).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* malformed link */ } }
  return [...domains];
}

const locationCatalog: Array<[string, string[]]> = [
  ['United States', ['united states', 'u.s.a.', 'usa', 'u.s.']], ['Canada', ['canada']], ['Mexico', ['mexico']],
  ['United Kingdom', ['united kingdom', 'uk', 'u.k.']], ['Ireland', ['ireland']], ['Germany', ['germany']], ['France', ['france']], ['Netherlands', ['netherlands']], ['Spain', ['spain']], ['Portugal', ['portugal']], ['Switzerland', ['switzerland']], ['Poland', ['poland']], ['Europe', ['europe', 'eu']],
  ['Taiwan', ['taiwan']], ['Japan', ['japan']], ['South Korea', ['south korea', 'korea']], ['Singapore', ['singapore']], ['Hong Kong', ['hong kong']], ['India', ['india']], ['Australia', ['australia']], ['New Zealand', ['new zealand']], ['Israel', ['israel']], ['Brazil', ['brazil']],
  ['New York', ['new york']], ['San Francisco', ['san francisco']], ['Seattle', ['seattle']], ['Los Angeles', ['los angeles']], ['Boston', ['boston']], ['Toronto', ['toronto']], ['Vancouver', ['vancouver']], ['London', ['london']], ['Berlin', ['berlin']], ['Munich', ['munich']], ['Paris', ['paris']], ['Amsterdam', ['amsterdam']], ['Dublin', ['dublin']], ['Singapore', ['singapore']], ['Taipei', ['taipei']]
];

export function extractLocationSignals(text: string): LocationSignals {
  const locations = new Set<string>();
  const evidence: string[] = [];
  const addEvidence = (pattern: RegExp) => { for (const match of text.matchAll(pattern)) { const value = match[0].replace(/\s+/g, ' ').trim(); if (value && !evidence.includes(value)) evidence.push(value); } };
  for (const [canonical, aliases] of locationCatalog) {
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${aliases.map((alias) => alias.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&').replace(/\\s+/g, '\\\\s+')).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
    if (pattern.test(text)) locations.add(canonical);
  }
  if (/\b(?:us|u\.s\.)\s+(?:only|based|residents?|time(?:zone| zones?)?)\b/i.test(text)) locations.add('United States');
  const globalPattern = /\b(?:remote\s+)?(?:worldwide|global(?:ly)?|anywhere(?: in the world)?|work from anywhere|open to all countries)\b/gi;
  const locationPhrase = /\b(?:remote|based|located|residing|residents?|work(?:ing)?)\s+(?:in|from|within|[-:])\s+[\w'. -]{2,48}/gi;
  const restriction = /\b(?:[a-z. -]+\s+only|must be (?:based|located|resident) in [\w'. -]{2,48}|residents? of [\w'. -]{2,48}|no visa sponsorship|work authorization(?: required)?)\b/gi;
  addEvidence(globalPattern); addEvidence(locationPhrase); addEvidence(restriction);
  for (const pattern of [
    /\b(?:remote|based|located|residing|work(?:ing)?)\s+(?:in|from|within|[-:])\s+([A-Z][A-Za-z]+(?:[ -][A-Z][A-Za-z]+){0,2})/g,
    /(?:📍|\blocation:)\s*([A-Z][A-Za-z]+(?:[ -][A-Z][A-Za-z]+){0,2})/g
  ]) for (const match of text.matchAll(pattern)) { const candidate = match[1].replace(/\s+(?:only|remote)$/i, '').trim(); if (candidate && !/^(worldwide|globally|anywhere)$/i.test(candidate)) locations.add(candidate); }
  const timezoneMatches = [
    ...text.matchAll(/\b(?:UTC|GMT)\s*[+-]\s*\d{1,2}(?::\d{2})?\b/gi),
    ...text.matchAll(/\b(?:Pacific|Mountain|Central|Eastern|Atlantic|British|Central European|India|Japan|Australia Eastern)\s+(?:Time|hours?|timezone)\b/gi),
    ...text.matchAll(/\b(?:PST|PDT|MST|MDT|CST|CDT|EST|EDT|CET|CEST|IST|JST|AEST)\b/gi)
  ];
  const timezoneRequirements = [...new Set(timezoneMatches.map((match) => match[0].replace(/\s+/g, ' ').trim()))];
  const global = globalPattern.test(text) || /\bremote[- ]?worldwide\b/i.test(text);
  const regions = [...new Set([
    /\b(?:APAC|Asia[- ]Pacific|Asia Pacific)\b/i.test(text) ? 'APAC' : '',
    /\b(?:Asia|Asian)\b/i.test(text) ? 'Asia' : '',
    /\b(?:EMEA|Europe(?:an)?|European Union|EU)\b/i.test(text) ? 'Europe' : '',
    /\b(?:Americas|North America|Latin America)\b/i.test(text) ? 'Americas' : ''
  ].filter(Boolean))];
  const workEligibility = global ? 'worldwide' : regions.length > 0 ? 'regional' : locations.size > 0 ? 'country_specific' : 'unknown';
  const hasRemote = /\b(remote|remotely|distributed|work from home|work from anywhere|fully virtual)\b/i.test(text);
  const hasOnsite = /\b(on[- ]?site|in[- ]office|office[- ]based|work from the office)\b/i.test(text);
  const hasHybrid = /\bhybrid\b/i.test(text);
  const workMode = hasHybrid || (hasRemote && hasOnsite) ? 'hybrid' : hasRemote ? 'remote' : hasOnsite ? 'onsite' : 'unknown';
  const hasLocationPhrase = /\b(?:remote|based|located|residing|residents?|work(?:ing)?)\s+(?:in|from|within)\s+[\w'. -]{2,48}/i.test(text);
  const hasRestriction = /\b(?:[a-z. -]+\s+only|must be (?:based|located|resident) in [\w'. -]{2,48}|residents? of [\w'. -]{2,48}|no visa sponsorship|work authorization(?: required)?)\b/i.test(text);
  const constraint = global ? 'allowed' : (locations.size > 0 && (hasLocationPhrase || hasRestriction)) || hasRestriction ? 'restricted' : 'unknown';
  const employerLocations = [...locations].filter((location) => /\b(?:company|employer|team|startup|business)\b.{0,30}\b(?:based|located)\b/i.test(text));
  return { workMode, locations: [...locations], employerLocations, regions, workEligibility, constraint, timezoneRequirements, evidence: evidence.slice(0, 12) };
}

export function evaluateLocationFit(signals: LocationSignals, preferences: Preferences): { fit: LocationFit; score: number; reasons: string[] } {
  const profile = preferences.locationProfile;
  const base = profile.baseLocation.toLowerCase();
  const preferredRegions = profile.preferredRegions.map((region) => region.toLowerCase());
  const locations = signals.locations.map((location) => location.toLowerCase());
  const taiwanMatch = locations.some((location) => location === base || (base === 'taiwan' && /taiwan/.test(location)));
  const regionMatch = signals.regions.some((region) => preferredRegions.includes(region.toLowerCase()));
  const timezoneMatch = signals.timezoneRequirements.some((timezone) => {
    const match = timezone.match(/(?:utc|gmt)\s*([+-])\s*(\d{1,2})/i);
    if (!match) return /apac|asia|taipei|japan|singapore/i.test(timezone) && preferredRegions.some((region) => /apac|asia/i.test(region));
    const offset = Number(match[2]) * (match[1] === '-' ? -1 : 1);
    return Math.abs(offset - profile.utcOffset) <= 3;
  });
  const reasons: string[] = [];
  if (signals.workMode === 'onsite' && !taiwanMatch) return { fit: 'poor', score: 5, reasons: [`On-site outside ${profile.baseLocation}`] };
  if (signals.constraint === 'restricted' && signals.workEligibility === 'country_specific' && !taiwanMatch) return { fit: 'poor', score: 15, reasons: [`Restricted to ${signals.locations.join(', ') || 'a specific location'}`] };
  if (taiwanMatch) { reasons.push(`${profile.baseLocation} explicitly included`); return { fit: 'excellent', score: 100, reasons }; }
  if (signals.workEligibility === 'worldwide') { reasons.push('Worldwide or globally open'); return { fit: 'excellent', score: 95, reasons }; }
  if (regionMatch || timezoneMatch) { reasons.push(regionMatch ? `${signals.regions.join(', ')} matches preferred regions` : `Timezone appears compatible with ${profile.timeZone}`); return { fit: 'excellent', score: 85, reasons }; }
  if (signals.workMode === 'remote' && signals.constraint !== 'restricted') { reasons.push('Remote with no explicit location restriction'); return { fit: 'good', score: 70, reasons }; }
  if (signals.workMode === 'hybrid') return { fit: 'possible', score: 40, reasons: ['Hybrid role needs location confirmation'] };
  if (signals.workMode === 'remote') return { fit: 'possible', score: 45, reasons: ['Remote, but location eligibility is unclear'] };
  return { fit: 'unknown', score: 25, reasons: ['No explicit base-location-compatible evidence'] };
}

function contactMethods(text: string): ContactMethod[] {
  const methods: ContactMethod[] = [];
  for (const email of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) methods.push({ type: 'email', value: email, source: 'post text' });
  if (/\b(dm me|direct message|send me your portfolio|reach out|happy to chat|message me)\b/i.test(text)) methods.push({ type: 'dm', value: 'Author invites direct contact', source: 'post text' });
  if (/\b(reply here|comment below|reply to this|reach out here)\b/i.test(text)) methods.push({ type: 'reply', value: 'Author invites a reply', source: 'post text' });
  for (const link of text.match(/https?:\/\/[^\s)]+/gi) ?? []) {
    const clean = link.replace(/[.,!?]+$/, '');
    const type = /\b(apply|application|jobs?|careers?|opening)\b/i.test(text) ? 'application_link' : 'professional_page';
    methods.push({ type, value: clean, source: 'post text' });
  }
  return methods.filter((method, index, all) => all.findIndex((candidate) => candidate.type === method.type && candidate.value === method.value) === index);
}

function registryMatch(text: string, post: NormalizedPost, registry: Array<{ match_type: string; pattern: string; label: string }>): string[] {
  const domains = extractOutboundDomains(text);
  return registry.filter((entry) => {
    const pattern = entry.pattern.toLowerCase();
    if (entry.match_type === 'domain') return domains.some((domain) => domain === pattern || domain.endsWith(`.${pattern}`));
    if (entry.match_type === 'account') return [post.authorId, post.authorHandle, post.authorName].filter(Boolean).some((value) => value!.toLowerCase() === pattern);
    return text.toLowerCase().includes(pattern);
  }).map((entry) => entry.label);
}

function classifySignal(text: string, post: NormalizedPost, author: AuthorSignals, registry: Array<{ match_type: string; pattern: string; label: string }>, methods: ContactMethod[]): { category: SignalCategory; quality: number; breakdown: ScoreContribution[]; reasons: string[]; suppressed: boolean } {
  const evidence = registryMatch(text, post, registry);
  const activeDemand = /\b(looking for|seeking|need|hiring|hire|anyone know|anyone available|want to hire)\b/i.test(text);
  const firstPerson = /\b(i'm|i am|we're|we are|my team|our team|founder|cto|hiring manager)\b/i.test(text);
  const direct = /\b(we're hiring|we are hiring|i'm hiring|i am hiring|looking for (a|an|someone)|founding engineer|know any good (developers|engineers)|need a (contractor|developer|freelancer)|send me your portfolio)\b/i.test(text);
  const service = /\b(looking for someone to build|need help (with|building)|integrate (stripe|paypal|an api)|internal dashboard|migrat(e|ing) (our |the )?infrastructure|reliable freelance (programmer|developer)|available for contract work|looking for a freelancer)\b/i.test(text) && (matchingTerms(text, ['backend', 'developer', 'engineer', 'software', 'dashboard', 'infrastructure', 'api', 'automation', 'stripe', 'node.js', 'typescript', 'python']).length > 0);
  const referral = /\b(my team is hiring|our team is hiring|we're growing (the )?engineering team|happy to chat.*(interested|engineer|developer)|my company is hiring)\b/i.test(text);
  const hasApplicationLink = methods.some((method) => method.type === 'application_link');
  const firsthand = hasApplicationLink && firstPerson && activeDemand && !evidence.length;
  const templateMarkers = ['new remote job alert', 'position:', 'company:', 'location:', 'category:', 'apply now', '#jobopportunity', '#remotejobs'].filter((marker) => text.toLowerCase().includes(marker)).length;
  const automatedTemplate = templateMarkers >= 2 || /new remote job alert|job board|jobs? roundup|\d+ new jobs/i.test(text);
  const selfPromotion = /\b(i am|i'm) (a |an )?(freelance|contract|software|web|backend|frontend) (developer|engineer|programmer)|looking for clients|hire me|available for work\b/i.test(text) && !activeDemand;
  let category: SignalCategory = 'uncertain';
  let suppressed = false;
  const reasons: string[] = [];
  if (author.classification === 'aggregator' || (author.isKnownAggregator && author.classification !== 'legitimate_employer') || evidence.length || automatedTemplate) { category = 'aggregated_listing'; suppressed = true; reasons.push(evidence.length ? `Known aggregator evidence: ${evidence.join(', ')}` : 'Templated or syndicated job advertisement pattern'); }
  else if (service) { category = 'software_request'; reasons.push('Post describes a concrete software or infrastructure need'); }
  else if (referral) { category = 'employee_referral'; reasons.push('Author presents a team/company hiring opportunity and invites contact'); }
  else if (direct) { category = 'direct_hiring'; reasons.push('Author expresses active personal hiring intent'); }
  else if (firsthand) { category = 'firsthand_announcement'; reasons.push('First-person hiring context accompanies a formal listing'); }
  else if (selfPromotion) { category = 'uncertain'; suppressed = true; reasons.push('Author appears to be offering their own services rather than requesting help'); }
  else { reasons.push('Hiring-related language lacks enough firsthand context'); }
  const quality: ScoreContribution[] = [];
  const base = category === 'software_request' ? 75 : category === 'direct_hiring' ? 70 : category === 'employee_referral' ? 65 : category === 'firsthand_announcement' ? 55 : category === 'aggregated_listing' ? 5 : 20;
  addContribution(quality, 'Signal category', base, [category]);
  if (activeDemand && category !== 'aggregated_listing') addContribution(quality, 'Active demand language', 10, ['active request']);
  if (firstPerson && category !== 'aggregated_listing') addContribution(quality, 'Firsthand author context', 10, ['first-person or team context']);
  if (methods.length && category !== 'aggregated_listing') addContribution(quality, 'Actionable contact', 10, methods.map((method) => method.type));
  if (selfPromotion) reasons.push('Possible self-promotion');
  const score = suppressed ? Math.min(15, base) : Math.min(100, quality.reduce((sum, item) => sum + item.points, 0));
  return { category, quality: score, breakdown: quality, reasons, suppressed };
}

export function analyzePost(post: NormalizedPost, rules: DetectionRule[], preferences: Preferences, author: AuthorSignals = {}, registry: Array<{ match_type: string; pattern: string; label: string }> = []): Analysis {
  const text = normalizeText(post.text);
  const matches = rules.filter((rule) => rule.enabled && ruleMatches(text, rule));
  const matchedRules = matches.map((rule) => ({ id: rule.id, name: rule.name, pattern: rule.pattern, category: rule.category, negative: rule.negative }));
  const blocked = matches.some((rule) => rule.negative);
  const positiveMatches = matches.filter((rule) => !rule.negative);
  const technologies = matchingTerms(text, preferences.technologyTerms);
  const roleTerms = matchingTerms(text, preferences.roleTerms);
  const remoteTerms = matchingTerms(text, preferences.remoteTerms);
  const internationalTerms = matchingTerms(text, preferences.internationalTerms);
  const contractTerms = matchingTerms(text, preferences.contractTerms);
  const contactTerms = matchingTerms(text, preferences.contactTerms);
  const methods = contactMethods(text);
  const extractedLocations = extractLocationSignals(text);
  const locationFit = evaluateLocationFit(extractedLocations, preferences);
  const employmentTypes = [contractTerms.some((term) => /contract|freelance|consult|part-time/i.test(term)) ? 'contract/freelance' : '', /\bfull[- ]?time\b/i.test(text) ? 'full-time' : '', /\bpart[- ]?time\b/i.test(text) ? 'part-time' : ''].filter(Boolean);
  const quality = classifySignal(text, post, author, registry, methods);
  const breakdown: ScoreContribution[] = [];
  const categoryWeight = (category: string, fallback: number) => Number.isFinite(Number(preferences.weights?.[category])) ? Number(preferences.weights[category]) : fallback;
  addContribution(breakdown, 'Relevant role', Math.min(categoryWeight('role', 18), roleTerms.length * categoryWeight('role', 18)), roleTerms);
  addContribution(breakdown, 'Technology match', Math.min(categoryWeight('technology', 28), technologies.length * 7), technologies);
  addContribution(breakdown, 'Remote preference', Math.min(categoryWeight('remote', 12), remoteTerms.length * categoryWeight('remote', 12)), remoteTerms);
  addContribution(breakdown, 'International signal', Math.min(categoryWeight('international', 8), internationalTerms.length * categoryWeight('international', 8)), internationalTerms);
  addContribution(breakdown, 'Contract / freelance', Math.min(categoryWeight('contract', 10), contractTerms.length * categoryWeight('contract', 10)), contractTerms);
  addContribution(breakdown, 'Direct contact signal', Math.min(categoryWeight('contact', 8), contactTerms.length * categoryWeight('contact', 8)), contactTerms);
  const personalRelevance = blocked ? 0 : Math.min(100, Math.round(breakdown.reduce((total, item) => total + item.points, 0)));
  return { matchedRules, technologies, employmentTypes, category: blocked ? 'uncertain' : quality.category, signalQuality: blocked ? 0 : quality.quality, signalQualityBreakdown: quality.breakdown, personalRelevance, personalRelevanceBreakdown: breakdown, contactMethods: methods, classificationReasons: quality.reasons, locationSignals: extractedLocations, locationFit: blocked ? 'unknown' : locationFit.fit, locationFitScore: blocked ? 0 : locationFit.score, locationFitReasons: blocked ? ['Blocked by a negative detection rule'] : locationFit.reasons, score: personalRelevance, breakdown, suppressed: blocked || quality.suppressed, blocked };
}

export function notificationEligible(analysis: Analysis, recovered: boolean, preferences: Preferences): boolean {
  if (!preferences.notificationsEnabled || analysis.suppressed || analysis.signalQuality < preferences.minimumNotificationSignalQuality || analysis.personalRelevance < preferences.minimumNotificationPersonalRelevance || analysis.locationFitScore < preferences.minimumNotificationLocationFitScore) return false;
  if (recovered && !preferences.notifyRecovered) return false;
  return true;
}

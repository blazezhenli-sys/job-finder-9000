import { evaluateLocationFit, extractLocationSignals } from '../pipeline.js';
import type { ListingAnalysis, NormalizedJobListing, Preferences, ScoreContribution } from '../types.js';

function matches(text: string, term: string): boolean { const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'); return Boolean(escaped) && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text); }
function terms(text: string, list: string[]): string[] { return list.filter((term) => matches(text, term)); }
function add(list: ScoreContribution[], label: string, points: number, evidence: string[]) { if (points > 0) list.push({ label, points, evidence }); }

export function analyzeListing(listing: NormalizedJobListing, preferences: Preferences): ListingAnalysis {
  const text = [listing.title, listing.description, listing.department, listing.team, listing.location, ...(listing.secondaryLocations ?? []), ...(listing.geographicRestrictions ?? [])].filter(Boolean).join('\n');
  const technologyTerms = terms(text, preferences.technologyTerms);
  const roleTerms = terms(`${listing.title}\n${listing.description}`, preferences.roleTerms);
  const remoteTerms = terms(text, preferences.remoteTerms);
  const internationalTerms = terms(text, preferences.internationalTerms);
  const contractTerms = terms(text, preferences.contractTerms);
  const breakdown: ScoreContribution[] = [];
  add(breakdown, 'Relevant role', Math.min(25, roleTerms.length * 8), roleTerms);
  add(breakdown, 'Technology match', Math.min(30, technologyTerms.length * 6), technologyTerms);
  add(breakdown, 'Remote preference', listing.remoteMode === 'remote' || listing.remoteMode === 'hybrid' ? 15 : Math.min(8, remoteTerms.length * 4), listing.remoteMode && listing.remoteMode !== 'unknown' ? [listing.remoteMode] : remoteTerms);
  add(breakdown, 'International signal', Math.min(12, internationalTerms.length * 6), internationalTerms);
  add(breakdown, 'Contract / freelance', Math.min(12, contractTerms.length * 6), contractTerms);
  const locationSignals = extractLocationSignals(text);
  if (listing.remoteMode && listing.remoteMode !== 'unknown') locationSignals.workMode = listing.remoteMode;
  const location = evaluateLocationFit(locationSignals, preferences);
  const personalRelevance = Math.min(100, Math.round(breakdown.reduce((total, item) => total + item.points, 0)));
  return { technologies: technologyTerms, employmentType: listing.employmentType ?? (contractTerms.length ? 'contract/freelance' : ''), personalRelevance, relevanceBreakdown: breakdown, locationSignals, locationFit: location.fit, locationFitScore: location.score, locationFitReasons: location.reasons };
}

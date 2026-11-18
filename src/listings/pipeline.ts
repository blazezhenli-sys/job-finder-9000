import { evaluateLocationFit, extractLocationSignals, scorePreferenceEvidence } from '../pipeline.js';
import type { ListingAnalysis, LocationSignals, NormalizedJobListing, Preferences } from '../types.js';

export function listingLocationSignals(listing: Pick<NormalizedJobListing, 'location' | 'secondaryLocations' | 'geographicRestrictions' | 'remoteMode' | 'description'>): LocationSignals {
  // ATS location fields describe where the candidate may work.  Keep them
  // separate from the description: descriptions frequently mention offices,
  // customers, and markets that are unrelated to candidate eligibility.
  const structuredText = [listing.location, ...(listing.secondaryLocations ?? []), ...(listing.geographicRestrictions ?? [])].filter(Boolean).join('\n');
  const structured = extractLocationSignals(structuredText);
  const workMode = listing.remoteMode ?? extractLocationSignals(listing.description).workMode;

  return {
    ...structured,
    workMode,
    // Do not let incidental prose override the structured ATS location. A
    // description can mention customers, offices, or markets without saying
    // where this particular job may be performed.
    timezoneRequirements: structured.timezoneRequirements,
    evidence: structured.evidence
  };
}

export function analyzeListing(listing: NormalizedJobListing, preferences: Preferences): ListingAnalysis {
  const locationSignals = listingLocationSignals(listing);
  const location = evaluateLocationFit(locationSignals, preferences);
  const text = [listing.title, listing.description, listing.department, listing.team].filter(Boolean).join(' ');
  const relevance = scorePreferenceEvidence(text, preferences);
  return { technologies: relevance.technologies, employmentType: listing.employmentType ?? '', personalRelevance: relevance.score, relevanceBreakdown: relevance.breakdown, locationSignals, locationFit: location.fit, locationFitScore: location.score, locationFitReasons: location.reasons };
}

export type SourceName = 'bluesky' | 'hacker_news' | 'mastodon' | 'reddit';
export type OpportunityStatus = 'unread' | 'interesting' | 'dismissed' | 'contacted';
export type SignalCategory = 'direct_hiring' | 'service_request' | 'employee_referral' | 'firsthand_announcement' | 'aggregated_listing' | 'uncertain';
export type AuthorClassification = 'unknown' | 'aggregator' | 'employer' | 'legitimate_employer';
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type LocationConstraint = 'allowed' | 'restricted' | 'unknown';
export type LocationFit = 'excellent' | 'good' | 'possible' | 'poor' | 'unknown';
export type AtsProvider = 'greenhouse' | 'ashby' | 'lever' | 'remotive' | 'adzuna';
export type BoardStatus = 'active' | 'disabled';
export type JobListingStatus = 'new' | 'saved' | 'dismissed' | 'applied';

export interface DetectionRule {
  id: string;
  name: string;
  pattern: string;
  match_type: 'phrase' | 'regex';
  category: string;
  weight: number;
  negative: boolean;
  enabled: boolean;
}

export interface NormalizedPost {
  source: SourceName;
  sourceId: string;
  authorId?: string;
  authorName: string;
  authorHandle: string;
  authorBio?: string;
  authorWebsites?: string[];
  authorUrl: string;
  sourceUrl: string;
  text: string;
  publishedAt: Date;
  raw?: unknown;
}

export interface MatchedRule {
  id: string;
  name: string;
  pattern: string;
  category: string;
  negative: boolean;
}

export interface ScoreContribution {
  label: string;
  points: number;
  evidence: string[];
}

export interface ContactMethod { type: 'email' | 'dm' | 'reply' | 'professional_page' | 'application_link'; value: string; source: string }

export interface AuthorSignals {
  classification?: AuthorClassification;
  isKnownAggregator?: boolean;
  aggregatorEvidence?: string[];
}

export interface LocationSignals {
  workMode: WorkMode;
  locations: string[];
  countries: string[];
  employerLocations: string[];
  regions: string[];
  workEligibility: 'worldwide' | 'regional' | 'country_specific' | 'unknown';
  constraint: LocationConstraint;
  timezoneRequirements: string[];
  evidence: string[];
}

export interface HeuristicPreferences {
  activeDemandTerms: string[];
  firstPersonTerms: string[];
  directHiringTerms: string[];
  serviceRequestTerms: string[];
  serviceEvidenceTerms: string[];
  referralTerms: string[];
  automatedTemplateTerms: string[];
  selfPromotionTerms: string[];
  automatedTemplateThreshold: number;
}

export interface Analysis {
  matchedRules: MatchedRule[];
  technologies: string[];
  employmentTypes: string[];
  category: SignalCategory;
  signalQuality: number;
  signalQualityBreakdown: ScoreContribution[];
  personalRelevance: number;
  personalRelevanceBreakdown: ScoreContribution[];
  contactMethods: ContactMethod[];
  classificationReasons: string[];
  locationSignals: LocationSignals;
  locationFit: LocationFit;
  locationFitScore: number;
  locationFitReasons: string[];
  score: number;
  breakdown: ScoreContribution[];
  suppressed: boolean;
  blocked: boolean;
}

export interface Preferences {
  minimumNotificationScore: number;
  minimumNotificationSignalQuality: number;
  minimumNotificationPersonalRelevance: number;
  notificationsEnabled: boolean;
  notifyRecovered: boolean;
  technologyTerms: string[];
  roleTerms: string[];
  remoteTerms: string[];
  internationalTerms: string[];
  contractTerms: string[];
  contactTerms: string[];
  weights: Record<string, number>;
  heuristics: HeuristicPreferences;
  listingsNotificationsEnabled: boolean;
  minimumListingRelevance: number;
}

export interface JobBoard {
  id: string;
  employerId: string;
  employerName: string;
  companyWebsite: string;
  identityDomain?: string;
  identityNameSource?: string;
  identityDomainSource?: string;
  identityLastObservedAt?: string | null;
  provider: AtsProvider;
  boardIdentifier: string;
  boardUrl: string;
  status: BoardStatus;
  discoverySource: string;
  firstDiscoveredAt: string;
  initializedAt?: string | null;
  lastSuccessfulPoll?: string | null;
  lastAttemptedPoll?: string | null;
  lastNewListingDiscovered?: string | null;
  pollingIntervalSeconds: number;
  consecutiveFailureCount: number;
  lastError?: string | null;
}

export interface NormalizedJobListing {
  providerJobId: string;
  title: string;
  companyName?: string;
  descriptionHtml?: string;
  description: string;
  department?: string;
  team?: string;
  location?: string;
  secondaryLocations?: string[];
  remoteMode?: WorkMode;
  geographicRestrictions?: string[];
  employmentType?: string;
  seniority?: string;
  compensation?: unknown;
  applicationUrl: string;
  originalUrl: string;
  publishedAt?: Date | null;
  updatedAt?: Date | null;
  raw: unknown;
}

export interface ListingAnalysis {
  technologies: string[];
  employmentType: string;
  personalRelevance: number;
  relevanceBreakdown: ScoreContribution[];
  locationSignals: LocationSignals;
  locationFit: LocationFit;
  locationFitScore: number;
  locationFitReasons: string[];
}

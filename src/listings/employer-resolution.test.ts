import { describe, expect, it } from 'vitest';
import { matchEmployer, type EmployerRow } from './employer-resolution.js';

const gladly: EmployerRow = {
  id: 'gladly', name: 'Gladly', website: 'https://gladly.com', verified_domain: '',
  identity_domain: 'about-us', identity_name_source: 'ats_board_page', identity_domain_source: 'ats_board_page'
};

describe('employer board resolution', () => {
  it('does not attach a strong unrelated board identity to the current employer', () => {
    const result = matchEmployer([gladly], {
      name: 'CoreWeave', domain: 'coreweave.com', confidence: 'high', sources: ['ats_redirect'], evidence: {}
    }, gladly.id);
    expect(result).toBeUndefined();
  });

  it('keeps weak identities on the current employer until stronger evidence arrives', () => {
    const result = matchEmployer([gladly], {
      name: 'Explore Our Open Positions', confidence: 'medium', sources: ['ats_board_page'], evidence: {}
    }, gladly.id);
    expect(result).toBe(gladly);
  });

  it('can retain a company when an old board redirects to its new domain', () => {
    const result = matchEmployer([gladly], {
      name: 'Gladly', domain: 'gladly.ai', confidence: 'high', sources: ['ats_redirect'], evidence: {}
    }, gladly.id);
    expect(result).toBe(gladly);
  });
});

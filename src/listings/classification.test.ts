import { describe, expect, it } from 'vitest';
import { classifyJobCategory, classifyListing, extractListingTechnologies } from './classification.js';

describe('listing market classification', () => {
  it('classifies engineering listings with a primary specialty and technologies', () => {
    const result = classifyListing({ title: 'Senior Backend Engineer', description: 'Build TypeScript services with PostgreSQL and AWS.', department: 'Engineering', team: 'Platform' });
    expect(result.jobCategory).toBe('software_engineering');
    expect(result.primarySpecialty).toBe('backend_api');
    expect(result.engineeringSpecialties).toContain('backend_api');
    expect(result.technologies).toEqual(expect.arrayContaining(['typescript', 'postgresql', 'aws']));
    expect(result.version).toBe(1);
  });

  it('does not treat ordinary prose as the Go language', () => {
    expect(extractListingTechnologies({ title: 'Product Manager', description: 'Go to market strategy and customer discovery.', department: 'Product', team: '' })).not.toContain('go');
  });

  it('classifies non-engineering roles deterministically', () => {
    expect(classifyJobCategory({ title: 'Senior Product Manager', description: 'Own the roadmap and customer discovery.', department: 'Product', team: '' })).toBe('product');
    expect(classifyJobCategory({ title: 'Customer Support Specialist', description: 'Help customers resolve technical issues.', department: 'Support', team: '' })).toBe('customer_support');
  });
});

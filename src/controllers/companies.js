/**
 * Company (tenant) controllers. The company is always req.tenant.companyId,
 * resolved from the caller's membership — never a client-supplied id.
 */

export function createCompanyController({ services }) {
  return {
    create(req) {
      const company = services.companies.createCompanyForUser(req.auth.userId, req.validBody);
      return { status: 201, headers: { Location: '/api/v1/companies/current' }, data: company };
    },

    current(req) {
      return { data: services.companies.getCompany(req.tenant.companyId) };
    },

    completeOnboarding(req) {
      return { data: services.companies.completeOnboarding(req.tenant.companyId) };
    },

    members(req) {
      return { data: services.companies.listMembers(req.tenant.companyId) };
    },
  };
}

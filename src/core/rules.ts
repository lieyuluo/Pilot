export interface CandidatePosition {
  id?: string;
  url?: string;
  title: string;
  company: string;
  city?: string;
  region?: string;
  salaryMinK?: number;
  salaryMaxK?: number;
  experienceMinYears?: number;
  education?: EducationLevel;
  industry?: string;
  publishedAt?: string;
  remote?: boolean;
  description?: string;
}

export type EducationLevel =
  "不限" | "中专/高中" | "大专" | "本科" | "硕士" | "博士";

export interface HardRuleSet {
  titleKeywords: readonly string[];
  cities: readonly string[];
  regions?: readonly string[];
  minSalaryK?: number;
  maxExperienceYears?: number;
  candidateEducation?: EducationLevel;
  companyBlacklist: readonly string[];
  companyAliases?: Readonly<Record<string, readonly string[]>>;
  industryBlacklist: readonly string[];
  publishedWithinDays?: number;
  allowRemote: boolean;
}

export interface RuleExclusion {
  field:
    | "title"
    | "location"
    | "salary"
    | "experience"
    | "education"
    | "company"
    | "industry"
    | "publishedAt"
    | "remote";
  code: string;
}

export interface RuleEvaluation {
  eligible: boolean;
  exclusions: RuleExclusion[];
}

export interface EvaluationOptions {
  now?: Date;
}

const EDUCATION_RANK: Record<EducationLevel, number> = {
  不限: 0,
  "中专/高中": 1,
  大专: 2,
  本科: 3,
  硕士: 4,
  博士: 5,
};

export function evaluateCandidate(
  candidate: CandidatePosition,
  rules: HardRuleSet,
  options: EvaluationOptions = {},
): RuleEvaluation {
  const exclusions: RuleExclusion[] = [];

  if (
    rules.titleKeywords.length > 0 &&
    !rules.titleKeywords.some((keyword) =>
      normalize(candidate.title).includes(normalize(keyword)),
    )
  ) {
    exclusions.push({ field: "title", code: "keyword-mismatch" });
  }

  if (
    rules.cities.length > 0 &&
    candidate.city !== undefined &&
    !includesNormalized(rules.cities, candidate.city)
  ) {
    exclusions.push({ field: "location", code: "city-mismatch" });
  }

  if (
    rules.regions !== undefined &&
    rules.regions.length > 0 &&
    candidate.region !== undefined &&
    !includesNormalized(rules.regions, candidate.region)
  ) {
    exclusions.push({ field: "location", code: "region-mismatch" });
  }

  if (candidate.remote === true && !rules.allowRemote) {
    exclusions.push({ field: "remote", code: "not-allowed" });
  }

  if (
    rules.minSalaryK !== undefined &&
    candidate.salaryMinK !== undefined &&
    candidate.salaryMinK < rules.minSalaryK
  ) {
    exclusions.push({ field: "salary", code: "below-minimum" });
  }

  if (
    rules.maxExperienceYears !== undefined &&
    candidate.experienceMinYears !== undefined &&
    candidate.experienceMinYears > rules.maxExperienceYears
  ) {
    exclusions.push({ field: "experience", code: "above-maximum" });
  }

  if (
    rules.candidateEducation !== undefined &&
    candidate.education !== undefined &&
    EDUCATION_RANK[candidate.education] >
      EDUCATION_RANK[rules.candidateEducation]
  ) {
    exclusions.push({ field: "education", code: "above-candidate" });
  }

  if (isCompanyBlacklisted(candidate.company, rules)) {
    exclusions.push({ field: "company", code: "blacklisted" });
  }

  if (
    candidate.industry !== undefined &&
    includesNormalized(rules.industryBlacklist, candidate.industry)
  ) {
    exclusions.push({ field: "industry", code: "blacklisted" });
  }

  if (
    rules.publishedWithinDays !== undefined &&
    candidate.publishedAt !== undefined
  ) {
    const publishedAt = new Date(candidate.publishedAt);
    if (!Number.isNaN(publishedAt.getTime())) {
      const now = options.now ?? new Date();
      const ageMs = now.getTime() - publishedAt.getTime();
      if (ageMs > rules.publishedWithinDays * 86_400_000) {
        exclusions.push({ field: "publishedAt", code: "too-old" });
      }
    }
  }

  return { eligible: exclusions.length === 0, exclusions };
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function includesNormalized(
  values: readonly string[],
  target: string,
): boolean {
  const normalizedTarget = normalize(target);
  return values.some((value) => normalize(value) === normalizedTarget);
}

function isCompanyBlacklisted(company: string, rules: HardRuleSet): boolean {
  const normalizedCompany = normalize(company);
  return rules.companyBlacklist.some((blockedCompany) => {
    const names = [
      blockedCompany,
      ...(rules.companyAliases?.[blockedCompany] ?? []),
    ];
    return names.some((name) => normalize(name) === normalizedCompany);
  });
}

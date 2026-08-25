import { describe, expect, it } from "vitest";

import {
  evaluateCandidate,
  type CandidatePosition,
  type HardRuleSet,
} from "../../src/core/rules.ts";

const baseCandidate: CandidatePosition = {
  id: "job-1",
  title: "Go 开发工程师",
  company: "远山科技",
  city: "北京",
};

const baseRules: HardRuleSet = {
  titleKeywords: ["Go"],
  cities: ["北京"],
  companyBlacklist: [],
  industryBlacklist: [],
  allowRemote: false,
};

describe("evaluateCandidate", () => {
  it("排除明确低于最低薪资的候选职位", () => {
    const result = evaluateCandidate(
      { ...baseCandidate, salaryMinK: 15 },
      { ...baseRules, minSalaryK: 20 },
    );

    expect(result).toEqual({
      eligible: false,
      exclusions: [{ field: "salary", code: "below-minimum" }],
    });
  });

  it("排除标题未命中任一岗位关键词的候选职位", () => {
    const result = evaluateCandidate(
      { ...baseCandidate, title: "Java 开发工程师" },
      baseRules,
    );

    expect(result.exclusions).toContainEqual({
      field: "title",
      code: "keyword-mismatch",
    });
  });

  it.each([
    [
      "城市",
      { city: "上海" },
      baseRules,
      { field: "location", code: "city-mismatch" },
    ],
    [
      "区域",
      { region: "海淀区" },
      { ...baseRules, regions: ["朝阳区"] },
      { field: "location", code: "region-mismatch" },
    ],
    [
      "远程",
      { remote: true },
      baseRules,
      { field: "remote", code: "not-allowed" },
    ],
    [
      "经验",
      { experienceMinYears: 5 },
      { ...baseRules, maxExperienceYears: 3 },
      { field: "experience", code: "above-maximum" },
    ],
    [
      "学历",
      { education: "硕士" },
      { ...baseRules, candidateEducation: "本科" },
      { field: "education", code: "above-candidate" },
    ],
    [
      "行业",
      { industry: "保险" },
      { ...baseRules, industryBlacklist: ["保险"] },
      { field: "industry", code: "blacklisted" },
    ],
  ] as const)(
    "排除明确不符合%s规则的候选职位",
    (_label, candidatePatch, rulePatch, expected) => {
      const result = evaluateCandidate(
        { ...baseCandidate, ...candidatePatch },
        { ...baseRules, ...rulePatch },
      );

      expect(result.exclusions).toContainEqual(expected);
    },
  );

  it("按规范化公司名和别名排除黑名单公司", () => {
    const result = evaluateCandidate(
      { ...baseCandidate, company: "远山科技有限公司" },
      {
        ...baseRules,
        companyBlacklist: ["远山科技"],
        companyAliases: { 远山科技: ["远山科技有限公司"] },
      },
    );

    expect(result.exclusions).toContainEqual({
      field: "company",
      code: "blacklisted",
    });
  });

  it("排除发布时间超过搜索方案期限的候选职位", () => {
    const result = evaluateCandidate(
      { ...baseCandidate, publishedAt: "2026-08-15T00:00:00.000Z" },
      { ...baseRules, publishedWithinDays: 7 },
      { now: new Date("2026-08-24T00:00:00.000Z") },
    );

    expect(result.exclusions).toContainEqual({
      field: "publishedAt",
      code: "too-old",
    });
  });

  it("字段缺失或无法解析时按未知值放行", () => {
    const result = evaluateCandidate(baseCandidate, {
      ...baseRules,
      minSalaryK: 30,
      maxExperienceYears: 3,
      candidateEducation: "本科",
      industryBlacklist: ["保险"],
      publishedWithinDays: 1,
    });

    expect(result).toEqual({ eligible: true, exclusions: [] });
  });
});

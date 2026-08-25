import type { PlatformAdapter } from "../../core/batch-runner.ts";
import type { SearchPlan } from "../../core/config.ts";
import type { CandidatePosition } from "../../core/rules.ts";

const FIXTURE_POSITIONS: CandidatePosition[] = [
  {
    id: "demo-go-001",
    title: "Go 后端开发工程师",
    company: "远山云计算",
    city: "北京",
    region: "海淀区",
    salaryMinK: 25,
    salaryMaxK: 40,
    experienceMinYears: 3,
    education: "本科",
    industry: "计算机软件",
    publishedAt: new Date().toISOString(),
    description: "负责 Go 服务端与平台工程建设。",
  },
  {
    id: "demo-go-002",
    title: "Go 微服务工程师",
    company: "北辰数据",
    city: "上海",
    region: "浦东新区",
    salaryMinK: 22,
    experienceMinYears: 2,
    education: "本科",
    industry: "互联网",
    publishedAt: new Date().toISOString(),
  },
  {
    id: "demo-python-001",
    title: "Python AI 应用开发",
    company: "澄明智能",
    city: "北京",
    region: "朝阳区",
    salaryMinK: 30,
    experienceMinYears: 3,
    education: "本科",
    industry: "人工智能",
    publishedAt: new Date().toISOString(),
  },
];

export function createFakeAdapter(): PlatformAdapter {
  const contacted = new Set<string>();
  return {
    async *scan(_plan: SearchPlan) {
      for (const position of FIXTURE_POSITIONS) {
        await delay(180);
        yield position;
      }
    },
    async currentContactState(candidate) {
      return candidate.id !== undefined && contacted.has(candidate.id)
        ? "已沟通"
        : "可沟通";
    },
    async sendOpening(candidate) {
      await delay(320);
      if (candidate.id !== undefined) {
        contacted.add(candidate.id);
      }
      return "已确认";
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import type { HardRuleSet } from "./rules.ts";

export interface SearchPlan {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  templateId: string;
  rules: HardRuleSet;
}

export interface OpeningTemplate {
  id: string;
  name: string;
  enabled: boolean;
  body: string;
}

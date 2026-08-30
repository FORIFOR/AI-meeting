import type { ConversationMode } from "@rcai/conversation-core";
import { PersonaRegistry, validatePersona, type Persona } from "@rcai/persona-core";
import interviewerJa from "../interview/interviewer_ja.json";
import interviewerEn from "../interview/interviewer_en.json";
import englishFreeTalk from "../english/english_free_talk.json";
import englishTravel from "../english/english_travel.json";
import englishBusiness from "../english/english_business.json";
import englishInterview from "../english/english_interview.json";
import englishDaily from "../english/english_daily.json";
import englishPronunciation from "../english/english_pronunciation.json";
import englishBeginner from "../english/english_beginner.json";
import salesCustomerJa from "../sales/sales_customer_ja.json";
import tutorJa from "../tutor/tutor_ja.json";
import friendJa from "../free_talk/friend_ja.json";
import careerCoachJa from "../career/career_coach_ja.json";

const RAW: unknown[] = [
  interviewerJa, interviewerEn,
  englishFreeTalk, englishTravel, englishBusiness, englishInterview, englishDaily, englishPronunciation, englishBeginner,
  salesCustomerJa, tutorJa, friendJa, careerCoachJa,
];

/** All bundled personas, validated at module load (spec §18: Character ≠ Personality). */
export const personas: Persona[] = RAW.map((p) => validatePersona(p));

export const personasByMode: Record<ConversationMode, Persona[]> = {
  free_talk: personas.filter((p) => p.mode === "free_talk"),
  interview: personas.filter((p) => p.mode === "interview"),
  english_lesson: personas.filter((p) => p.mode === "english_lesson"),
  sales_roleplay: personas.filter((p) => p.mode === "sales_roleplay"),
  tutor: personas.filter((p) => p.mode === "tutor"),
  career: personas.filter((p) => p.mode === "career"),
};

export function createPersonaRegistry(extra: Persona[] = []): PersonaRegistry {
  const reg = new PersonaRegistry();
  for (const p of [...personas, ...extra]) reg.register(p);
  return reg;
}

export function getPersona(id: string): Persona {
  return createPersonaRegistry().get(id);
}

/** Default persona per mode (first listed). */
export const DEFAULT_PERSONA_ID: Record<ConversationMode, string> = {
  free_talk: "friend_ja",
  interview: "interviewer_ja",
  english_lesson: "english_free_talk",
  sales_roleplay: "sales_customer_ja",
  tutor: "tutor_ja",
  career: "career_coach_ja",
};

import { GoogleGenAI } from "@google/genai";
import type { JudgeModel } from "./types";

export function createGeminiModel(apiKey: string, modelId: string, timeoutMs = 20000): JudgeModel {
  const ai = new GoogleGenAI({ apiKey });
  return {
    id: modelId,
    async generate(system, user, schema) {
      const res = await ai.models.generateContent({
        model: modelId,
        contents: user,
        config: {
          systemInstruction: system,
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          abortSignal: AbortSignal.timeout(timeoutMs),
        },
      });
      const text = res.text;
      if (!text) throw new Error("Gemini returned an empty response");
      return text;
    },
  };
}

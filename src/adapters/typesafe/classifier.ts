import type { IntentClassifier } from "../../core/ports";
import { classifyMessage, type ClassifyOptions } from "../../intent/classifier";

export function createIntentClassifier(
  options: ClassifyOptions,
): IntentClassifier {
  return {
    classify(context) {
      return classifyMessage(context, options);
    },
  };
}

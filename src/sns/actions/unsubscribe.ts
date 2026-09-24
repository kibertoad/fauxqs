import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export async function unsubscribe(
  params: Record<string, string>,
  snsStore: SnsStore,
): Promise<string> {
  const subscriptionArn = params.SubscriptionArn;
  if (!subscriptionArn) {
    throw new SnsError("InvalidParameter", "SubscriptionArn is required");
  }

  await snsStore.unsubscribe(subscriptionArn);
  return snsSuccessResponse("Unsubscribe", "");
}

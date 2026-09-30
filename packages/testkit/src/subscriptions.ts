import type {
  JSONRPCNotification,
  JSONRPCResultResponse,
  RequestId,
  SubscriptionFilter,
} from "@fetchling/protocol";
import { isObject } from "./json.js";

/** One open `subscriptions/listen` stream, as a transport sees it. */
export interface OpenSubscription {
  /** The JSON-RPC id of the listen request, which is also the subscription id. */
  id: RequestId;
  /** What the server acknowledged it will deliver. */
  filter: SubscriptionFilter;
  /** Write one notification to this stream (already tagged with the subscription id). */
  deliver(notification: JSONRPCNotification): void;
  /** Close the stream: graceful = with a final listen response (subscriptions.md § Graceful Closure). */
  end(graceful: boolean): void;
}

export interface SubscriptionRegistry {
  add(subscription: OpenSubscription): void;
  remove(id: RequestId): boolean;
  /** Deliver to every stream whose filter asked for this notification. Returns how many got it. */
  broadcast(notification: JSONRPCNotification): number;
  endAll(graceful: boolean): void;
  readonly size: number;
}

export function createSubscriptionRegistry(): SubscriptionRegistry {
  const open = new Map<string, OpenSubscription>();
  return {
    add(subscription) {
      open.set(key(subscription.id), subscription);
    },
    remove(id) {
      return open.delete(key(id));
    },
    broadcast(notification) {
      let delivered = 0;
      for (const subscription of open.values()) {
        if (!wants(subscription.filter, notification)) continue;
        subscription.deliver(tagged(notification, subscription.id));
        delivered += 1;
      }
      return delivered;
    },
    endAll(graceful) {
      const all = [...open.values()];
      open.clear();
      for (const subscription of all) subscription.end(graceful);
    },
    get size() {
      return open.size;
    },
  };
}

/** Whether a subscription filter opted in to this notification (subscriptions.md § Notification Filter). */
export function wants(
  filter: SubscriptionFilter,
  notification: JSONRPCNotification,
): boolean {
  switch (notification.method) {
    case "notifications/tools/list_changed":
      return filter.toolsListChanged === true;
    case "notifications/prompts/list_changed":
      return filter.promptsListChanged === true;
    case "notifications/resources/list_changed":
      return filter.resourcesListChanged === true;
    case "notifications/resources/updated": {
      const uri = isObject(notification.params) ? notification.params.uri : undefined;
      return (
        typeof uri === "string" && (filter.resourceSubscriptions ?? []).includes(uri)
      );
    }
    default:
      return false;
  }
}

/** The notification with `io.modelcontextprotocol/subscriptionId` set, as every stream message must carry it. */
export function tagged(
  notification: JSONRPCNotification,
  id: RequestId,
): JSONRPCNotification {
  const params = isObject(notification.params) ? notification.params : {};
  const meta = isObject(params._meta) ? params._meta : {};
  return {
    ...notification,
    params: {
      ...params,
      _meta: { ...meta, "io.modelcontextprotocol/subscriptionId": id },
    },
  };
}

/** The listen response that ends a subscription gracefully. */
export function closingResponse(id: RequestId): JSONRPCResultResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/subscriptionId": id },
    },
  };
}

/** 1 and "1" are different ids, so keys keep the type. */
function key(id: RequestId): string {
  return `${typeof id}:${id}`;
}

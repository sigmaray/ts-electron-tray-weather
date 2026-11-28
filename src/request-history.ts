export interface ApiRequest {
  timestamp: Date;
  api: string;
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  duration?: number;
}

export function createRequestHistory(limit = 100) {
  const entries: ApiRequest[] = [];
  return {
    entries,
    add(request: Omit<ApiRequest, 'timestamp'>): void {
      entries.push({ ...request, timestamp: new Date() });
      if (entries.length > limit) entries.shift();
    },
  };
}

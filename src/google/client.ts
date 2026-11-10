import { readFileSync } from 'node:fs';
import { searchconsole, type searchconsole_v1 } from '@googleapis/searchconsole';
import { JWT } from 'google-auth-library';

/** Read-only scope: Google rejects any write even if the server tried one. */
export const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export type WmxSite = searchconsole_v1.Schema$WmxSite;
export type WmxSitemap = searchconsole_v1.Schema$WmxSitemap;
export type SearchAnalyticsQueryRequest = searchconsole_v1.Schema$SearchAnalyticsQueryRequest;
export type SearchAnalyticsQueryResponse = searchconsole_v1.Schema$SearchAnalyticsQueryResponse;
export type ApiDataRow = searchconsole_v1.Schema$ApiDataRow;
export type InspectUrlIndexRequest = searchconsole_v1.Schema$InspectUrlIndexRequest;
export type UrlInspectionResult = searchconsole_v1.Schema$UrlInspectionResult;

/** Per-request options; `signal` aborts the HTTP request to Google. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** The read-only slice of the Search Console API that this server uses. */
export interface GscApi {
  listSites(opts?: RequestOptions): Promise<WmxSite[]>;
  getSite(siteUrl: string, opts?: RequestOptions): Promise<WmxSite>;
  listSitemaps(siteUrl: string, sitemapIndex?: string, opts?: RequestOptions): Promise<WmxSitemap[]>;
  getSitemap(siteUrl: string, feedpath: string, opts?: RequestOptions): Promise<WmxSitemap>;
  querySearchAnalytics(siteUrl: string, body: SearchAnalyticsQueryRequest, opts?: RequestOptions): Promise<SearchAnalyticsQueryResponse>;
  inspectUrl(body: InspectUrlIndexRequest, opts?: RequestOptions): Promise<UrlInspectionResult>;
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Reads and checks the service-account key file, failing early on a bad key. */
export function readServiceAccountKey(keyFile: string): ServiceAccountKey {
  let key: { type?: string; client_email?: string; private_key?: string };
  try {
    key = JSON.parse(readFileSync(keyFile, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read service account key at ${keyFile}: ${(err as Error).message}`);
  }
  if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new Error(`${keyFile} is not a service account key (expected "type": "service_account")`);
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

export function createGscApi(key: ServiceAccountKey): GscApi {
  const auth = new JWT({ email: key.client_email, key: key.private_key, scopes: [GSC_READONLY_SCOPE] });
  const sc = searchconsole({ version: 'v1', auth, timeout: 60_000, retry: false });
  return {
    async listSites(opts = {}) {
      return (await sc.sites.list({}, { signal: opts.signal })).data.siteEntry ?? [];
    },
    async getSite(siteUrl, opts = {}) {
      return (await sc.sites.get({ siteUrl }, { signal: opts.signal })).data;
    },
    async listSitemaps(siteUrl, sitemapIndex, opts = {}) {
      return (await sc.sitemaps.list({ siteUrl, sitemapIndex }, { signal: opts.signal })).data.sitemap ?? [];
    },
    async getSitemap(siteUrl, feedpath, opts = {}) {
      return (await sc.sitemaps.get({ siteUrl, feedpath }, { signal: opts.signal })).data;
    },
    async querySearchAnalytics(siteUrl, requestBody, opts = {}) {
      return (await sc.searchanalytics.query({ siteUrl, requestBody }, { signal: opts.signal })).data;
    },
    async inspectUrl(requestBody, opts = {}) {
      return (await sc.urlInspection.index.inspect({ requestBody }, { signal: opts.signal })).data.inspectionResult ?? {};
    },
  };
}

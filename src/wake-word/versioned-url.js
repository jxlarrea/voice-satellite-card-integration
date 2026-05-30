/* global __VERSION__ */

export function withWakeWordAssetVersion(url) {
  const version = typeof __VERSION__ === 'string' ? __VERSION__ : '';
  if (!version) return url;

  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  const params = query
    ? query.split('&').filter((part) => part && !part.startsWith('v='))
    : [];
  params.push(`v=${encodeURIComponent(version)}`);
  return `${path}?${params.join('&')}${hash}`;
}

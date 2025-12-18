// auth.js
// Shared OAuth, Webfinger, and token management helpers for ActivityPub and UI components

import * as oauth from 'https://cdn.jsdelivr.net/npm/oauth4webapi@3/+esm'


export const WEBFINGER_REGEXP =
    /^(?:acct:)?(?<username>[^@]+)@(?<domain>(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*)$/


export async function handleLogin() {
    const authorizationServer = {
        issuer: (new URL(localStorage.getItem('actor_id'))).origin,
        authorization_endpoint: localStorage.getItem('authorization_endpoint'),
        token_endpoint: localStorage.getItem('token_endpoint'),
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['read', 'write'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token']
    }
    const clientAuth = oauth.None()
    const client = {
        client_id: this.clientId
    }

    const state = sessionStorage.getItem('state')
    const codeVerifier = sessionStorage.getItem('code_verifier')
    const paramsObj = Object.fromEntries(new URLSearchParams(window.location.search).entries());
    console.log('[handleLogin] Starting token exchange with:', {
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        state,
        codeVerifier,
        params: paramsObj,
        authorizationServer
    });

    try {
        const params = oauth.validateAuthResponse(
            authorizationServer,
            client,
            new URLSearchParams(window.location.search),
            state
        )

        console.log('[handleLogin] validateAuthResponse params:', params);

        const response = await oauth.authorizationCodeGrantRequest(
            authorizationServer,
            client,
            clientAuth,
            params,
            this.redirectUri,
            codeVerifier
        )

        console.log('[handleLogin] authorizationCodeGrantRequest response:', response);

        const result = await oauth.processAuthorizationCodeResponse(
            authorizationServer,
            client,
            response
        )

        console.log('[handleLogin] processAuthorizationCodeResponse result:', result);

        saveResult(result)

        this.clearSession()

        window.location = this.successUri
    } catch (error) {
        console.error('[handleLogin] Error during token exchange:', error);
        this._error = error.message
    }
}


export async function getActorId(id) {
    const m = WEBFINGER_REGEXP.exec(id)
    if (!m) throw new Error('bad Webfinger format')
    const username = m.groups.username
    const domain = m.groups.domain
    const wfUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}%40${domain}`
    const res = await fetch(wfUrl, {
        headers: { Accept: 'application/jrd+json,application/json' }
    })
    if (!res.ok) throw new Error('Could not load webfinger')
    const json = await res.json()
    if (!json.links) throw new Error('No links in webfinger json')
    const actorLink = json.links.find(
        (obj) =>
            obj.rel == 'self' &&
            [
                'application/activity+json',
                'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
            ].includes(obj.type)
    )
    if (!actorLink) throw new Error('No ActivityPub actor ID in Webfinger')
    return actorLink.href
}

export async function getActor(actorId) {
    const res = await fetch(actorId, {
        headers: {
            Accept:
                'application/activity+json,application/lrd+json,application/json'
        }
    })
    if (!res.ok) throw new Error('Failure fetching actor')
    return await res.json()
}

export async function getCurrentActor() {
    const actorJSON = localStorage.getItem('actor')
    if (actorJSON) {
        return JSON.parse(actorJSON)
    } else {
        const actorId = localStorage.getItem('actor_id')
        const res = await apFetch(actorId, {
            headers: {
                Accept:
                    'application/activity+json,application/lrd+json,application/json'
            }
        })
        if (!res.ok) {
            throw new Error('Failure fetching actor')
        }
        const actor = await res.json()
        localStorage.setItem('actor', JSON.stringify(actor))
        return actor
    }
}


export function getAuthorizationEndpoint(actor) {
    return actor.endpoints?.oauthAuthorizationEndpoint
}

export function getTokenEndpoint(actor) {
    return actor.endpoints?.oauthTokenEndpoint
}

export function getProxyUrl(actor) {
    return actor.endpoints?.proxyUrl
}

export function buildAuthorizationUrl({
    authorizationUrl,
    clientId,
    redirectUri,
    codeChallenge,
    state
}) {
    const url = new URL(authorizationUrl)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'read write')
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    return url.toString()
}

export function saveResult(result) {
  localStorage.setItem('access_token', result.access_token)
  localStorage.setItem('refresh_token', result.refresh_token)
  localStorage.setItem('expires_in', result.expires_in)
  localStorage.setItem(
    'expires',
    Date.now() + result.expires_in * 1000
  )
}

export async function ensureFreshToken(clientId) {
  const expires = parseInt(localStorage.getItem('expires'))
  if (Date.now() > expires) {
    const authorizationServer = {
      issuer: (new URL(localStorage.getItem('actor_id'))).origin,
      authorization_endpoint: localStorage.getItem('authorization_endpoint'),
      token_endpoint: localStorage.getItem('token_endpoint'),
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['read', 'write'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token']
    }
    const clientAuth = oauth.None()
    const client = {
      client_id: clientId
    }
    const refreshToken = localStorage.getItem('refresh_token')
    try {
      const response = await oauth.refreshTokenGrantRequest(
        authorizationServer,
        client,
        clientAuth,
        refreshToken
      )
      const result = await oauth.processRefreshTokenResponse(
        authorizationServer,
        client,
        response
      )
      saveResult(result)
    } catch (error) {
      console.error(error)
    }
  }
}

 export async function apFetch(url, options = {}) {
    await ensureFreshToken()
    const accessToken = localStorage.getItem('access_token')
    const actorId = localStorage.getItem('actor_id')
    const urlObj = (typeof url === 'string')
        ? new URL(url)
        : url
    if (urlObj.origin == URL.parse(actorId).origin) {
        return await oauth.protectedResourceRequest(
            accessToken,
            options.method || 'GET',
            urlObj,
            options.headers,
            options.body
        )
    } else {
        const proxyUrl = localStorage.getItem('proxy_url')
        return await oauth.protectedResourceRequest(
            accessToken,
            'POST',
            proxyUrl,
            {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            new URLSearchParams({
                id: urlObj.toString()
            })
        )
    }
}


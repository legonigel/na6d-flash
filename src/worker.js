export default {
  async fetch(request, env, ctx) {
    // Fetch the static asset from ASSETS binding
    const response = await env.ASSETS.fetch(request);

    // Only set the country cookie on HTML responses (e.g. index.html)
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const country = request.cf?.country || '';

      // Clone the response so we can modify the headers
      const newResponse = new Response(response.body, response);

      // Append a secure session cookie with the country code
      newResponse.headers.append(
        'Set-Cookie',
        `na6d-country=${country}; Path=/; SameSite=Lax; Secure`
      );

      return newResponse;
    }

    return response;
  },
};

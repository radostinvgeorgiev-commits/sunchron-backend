import { GoogleAuth } from "google-auth-library";

export const GOOGLE_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";

export class GoogleAdcAuthError extends Error {
  constructor(
    message = "Google ADC автентикацията не е налична.",
    code = "GOOGLE_ADC_AUTH_FAILED",
    status = 503,
  ) {
    super(message);
    this.name = "GoogleAdcAuthError";
    this.code = code;
    this.status = status;
  }
}

export function createGoogleAuth({ GoogleAuthClass = GoogleAuth } = {}) {
  if (typeof GoogleAuthClass !== "function") {
    throw new GoogleAdcAuthError();
  }
  return new GoogleAuthClass({
    scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
  });
}

export async function createGoogleAuthClient({
  googleAuthFactory = createGoogleAuth,
  clientFactory = (auth) => auth?.getClient(),
} = {}) {
  if (
    typeof googleAuthFactory !== "function" ||
    typeof clientFactory !== "function"
  ) {
    throw new GoogleAdcAuthError();
  }

  try {
    const auth = await googleAuthFactory();
    const client = await clientFactory(auth);
    if (!client || typeof client.getRequestHeaders !== "function") {
      throw new Error("ADC client is unavailable");
    }
    return client;
  } catch (error) {
    if (error instanceof GoogleAdcAuthError) throw error;
    throw new GoogleAdcAuthError();
  }
}

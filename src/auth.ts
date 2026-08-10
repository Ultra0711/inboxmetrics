import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { db } from "@/db";
import { gmailAuth } from "@/db/schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          // Read-only is all this dashboard needs — no send/modify access.
          scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
          access_type: "offline", // required to get a refresh_token back
          prompt: "consent",      // forces Google to actually hand one over
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;

        // Save the refresh token so the cron route can use it later,
        // without needing you to be signed in at 8am/7pm.
        if (account.refresh_token) {
          await db.insert(gmailAuth).values({ refreshToken: account.refresh_token });
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string | undefined;
      return session;
    },
  },
});

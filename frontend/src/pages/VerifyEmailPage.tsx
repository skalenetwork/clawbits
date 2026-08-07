import { lazy, Suspense, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { WordmarkLink } from "@/components/WordmarkLink";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { errMsg, toast } from "@/lib/toast";

// Same deal as LoginPage: the WebGL runtime is dead weight until this route is
// actually reached, and the CSS gradient behind it is a complete picture alone.
const ShaderBackdrop = lazy(() => import("@/components/ShaderBackdrop"));

/**
 * Final step of a social sign-in that WorkOS gated behind email verification.
 *
 * The browser arrives here from ``/api/auth/social/callback`` after WorkOS
 * raised ``email_verification_required``. The pending-auth token is in an
 * httpOnly cookie set by the callback; the email is in ``?email=`` purely for
 * display. The user types the 6-digit code WorkOS emailed them, we POST
 * ``{code}`` to the backend, and on success the session cookie is installed
 * and we navigate to ``/home``.
 */
export default function VerifyEmailPage() {
  const { verifySocialEmailCode } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const email = searchParams.get("email") ?? "";
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const otpContainerRef = useRef<HTMLDivElement | null>(null);
  const submittedCodeRef = useRef("");

  const submitCode = async (value: string) => {
    if (loading || submittedCodeRef.current === value) return;
    submittedCodeRef.current = value;
    setLoading(true);
    try {
      await verifySocialEmailCode(value);
      void navigate("/home");
    } catch (err: unknown) {
      toast.error(errMsg(err, "Invalid or expired code"));
      submittedCodeRef.current = "";
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    await submitCode(code);
  };

  return (
    <div className="relative grid min-h-svh w-full bg-background lg:grid-cols-[2fr_3fr]">
      {/* This panel is the SAME canvas as LoginPage's - it is the next screen in
          the same funnel, and it used to be a neutral-grey slab with a dot grid
          and a 7xl sans headline, so signing in with Google changed art direction
          mid-flow. Kept as a copy rather than a shared primitive because there
          are only these two instances and each places its own gradient stops.

          Not aria-hidden as a whole (the old version was): it carries real links
          - the wordmark out to the marketing site, Privacy, Terms - and hiding
          their container leaves them focusable but invisible to a screen reader.
          The decorative layers inside opt out individually instead. */}
      <aside className="relative hidden p-2 lg:flex">
        <div className="relative flex flex-1 flex-col overflow-hidden rounded-2xl bg-[#141311] p-6 text-[#f7f5f1] pt-[calc(--spacing(6)+var(--titlebar-height))]">
          {/* Static candy-on-ink gradient: what shows before the shader chunk
              loads, without JS, or without WebGL. Stops match LoginPage's, which
              are placed for a tall column rather than the landing's landscape
              canvas - a rust floor with the pink/blue/grape band riding the
              lower third. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(90% 26% at 22% 70%, rgb(232 66 92 / 0.8), transparent 70%)," +
                "radial-gradient(85% 24% at 62% 74%, rgb(143 91 214 / 0.75), transparent 70%)," +
                "radial-gradient(80% 22% at 34% 78%, rgb(74 143 224 / 0.7), transparent 70%)," +
                "radial-gradient(120% 38% at 50% 104%, rgb(176 57 39 / 0.95), transparent 72%)," +
                "radial-gradient(100% 30% at 50% 92%, rgb(240 154 63 / 0.5), transparent 74%)," +
                "#141311",
            }}
          >
            <Suspense fallback={null}>
              <ShaderBackdrop fit="cover" worldWidth={1408} worldHeight={975} scale={0.5} offsetY={0.15} />
            </Suspense>
          </div>

          {/* Legibility scrim, under the text and over the shader. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(to top, rgb(20 19 17 / 0.72) 0%, rgb(20 19 17 / 0.34) 34%, transparent 62%)",
            }}
          />

          <div className="relative flex items-center gap-3">
            <WordmarkLink className="h-4 w-auto invert" />
          </div>

          <div className="relative mt-auto max-w-xl">
            <h1 className="font-serif text-2xl font-medium leading-[1.05] tracking-tight xl:text-3xl">
              One quick check.
            </h1>
            <p className="mt-3 max-w-md pr-12 text-[13px]/relaxed font-medium text-[#f7f5f1]/80">
              We need to confirm this email belongs to you before connecting it to a new sign-in method.
            </p>
          </div>

          <div className="relative mt-10 flex items-center justify-between text-xs font-medium text-[#f7f5f1]/60">
            <span>© Clawbits</span>
            <div className="flex gap-5">
              <Link to="/privacy" className="hover:text-[#f7f5f1]">Privacy</Link>
              <Link to="/terms" className="hover:text-[#f7f5f1]">Terms</Link>
            </div>
          </div>
        </div>
      </aside>

      <main className="relative flex flex-col">
        <header className="flex items-center justify-center px-6 lg:hidden pt-[calc(--spacing(16)+var(--titlebar-height))]">
          <WordmarkLink className="h-5 w-auto opacity-80 dark:opacity-100 dark:invert" />
        </header>

        <div className="flex flex-1 items-center justify-center px-6 py-12 sm:px-10">
          <div className="w-full max-w-sm">
            <div className="mb-10">
              <h2 className="text-3xl font-semibold tracking-tight">Verify your email</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {email
                  ? <>We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>. Enter it to finish signing in.</>
                  : <>We sent a 6-digit code to your email. Enter it to finish signing in.</>}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6" noValidate>
              <div className="space-y-3">
                <Label htmlFor="code" className="sr-only">6-digit code</Label>
                <div ref={otpContainerRef} className="flex justify-center">
                  <InputOTP
                    id="code"
                    name="clawbits-otp"
                    maxLength={6}
                    value={code}
                    onChange={(value) => {
                      setCode(value);
                      if (value.length === 6) void submitCode(value);
                    }}
                    disabled={loading}
                    autoFocus
                    autoComplete="one-time-code"
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    data-form-type="other"
                    containerClassName="gap-2"
                  >
                    <InputOTPGroup className="gap-2">
                      <InputOTPSlot index={0} className="size-10 sm:size-12 rounded-xl border text-base sm:text-lg font-medium first:rounded-xl last:rounded-xl" />
                      <InputOTPSlot index={1} className="size-10 sm:size-12 rounded-xl border text-base sm:text-lg font-medium first:rounded-xl last:rounded-xl" />
                      <InputOTPSlot index={2} className="size-10 sm:size-12 rounded-xl border text-base sm:text-lg font-medium first:rounded-xl last:rounded-xl" />
                    </InputOTPGroup>
                    <InputOTPSeparator />
                    <InputOTPGroup className="gap-2">
                      <InputOTPSlot index={3} className="size-10 sm:size-12 rounded-xl border text-base sm:text-lg font-medium first:rounded-xl last:rounded-xl" />
                      <InputOTPSlot index={4} className="size-10 sm:size-12 rounded-xl border text-base sm:text-lg font-medium first:rounded-xl last:rounded-xl" />
                      <InputOTPSlot index={5} className="size-10 sm:size-12 rounded-xl border text-base sm:text-lg font-medium first:rounded-xl last:rounded-xl" />
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              </div>

              <Button type="submit" disabled={loading || code.length < 6} size="lg" className="w-full">
                {loading ? "Verifying…" : "Verify"}
              </Button>

              <Link
                to="/login"
                className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
              >
                Back to sign in
              </Link>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

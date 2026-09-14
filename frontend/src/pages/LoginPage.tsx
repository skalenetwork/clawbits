import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import OAuthButtons from "@/components/OAuthButtons";
import { DevSignInPanel } from "@/components/DevSignInPanel";
import { errMsg, toast } from "@/lib/toast";
import { getDevAuthEnabled } from "@/lib/api";
import { WordmarkLink } from "@/components/WordmarkLink";
import { SombraGradient } from "@/components/SombraGradient";
import { DEFAULT_LANDING, NEXT_PARAM, safeReturnPath } from "@/lib/returnPath";

type Stage = "email" | "code";

export default function LoginPage() {
  const { sendMagic, verifyMagic } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  /** Where to land after a successful sign-in; ``/home`` when unset. */
  const next = safeReturnPath(searchParams.get(NEXT_PARAM)) ?? DEFAULT_LANDING;
  const [devAuthEnabled, setDevAuthEnabled] = useState(false);

  // Probe whether the backend has dev auth enabled. 404 => disabled.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enabled = await getDevAuthEnabled();
      if (!cancelled) setDevAuthEnabled(enabled);
    })();
    return () => { cancelled = true; };
  }, []);

  // OAuth callback errors land here via ?error=...
  useEffect(() => {
    const err = searchParams.get("error");
    if (err) toast.error(`Sign-in failed: ${err}`);
  }, [searchParams]);

  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const otpContainerRef = useRef<HTMLDivElement | null>(null);
  const submittedCodeRef = useRef<string>("");

  const submitCode = async (value: string) => {
    if (loading || submittedCodeRef.current === value) return;
    submittedCodeRef.current = value;
    setLoading(true);
    try {
      await verifyMagic(email, value);
      void navigate(next);
    } catch (err: unknown) {
      toast.error(errMsg(err, "Invalid or expired code"));
      submittedCodeRef.current = "";
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  const handleSendCode = async (e: React.SubmitEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await sendMagic(email);
      setStage("code");
      setTimeout(() => {
        otpContainerRef.current?.querySelector("input")?.focus();
      }, 0);
    } catch (err: unknown) {
      toast.error(errMsg(err, "Couldn't send sign-in code"));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.SubmitEvent) => {
    e.preventDefault();
    await submitCode(code);
  };

  return (
    <div className="relative grid min-h-svh w-full bg-background lg:grid-cols-[2fr_3fr]">
      {/* Not aria-hidden as a whole: it carries real links (the wordmark out to
          the marketing site, Privacy, Terms), and hiding their container would
          leave them focusable but invisible to a screen reader. The decorative
          layers inside opt out individually instead. */}
      <aside className="relative hidden lg:flex">
        {/* The marketing hero, continued: the landing's ink ground and ridge
            gradient; see components/SombraGradient.tsx. */}
        <div className="relative flex flex-1 flex-col overflow-hidden bg-[#141311] p-6 text-[#f7f5f1] pt-[calc(--spacing(6)+var(--titlebar-height))]">
          <SombraGradient />

          {/* Legibility scrim, under the text and over the gradient. The landing
              pools its ink at 50% 38% because its headline is centred high;
              this panel's copy sits on the floor, so the pool does too. */}
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
            <h1 className="font-display text-2xl leading-[1.084] tracking-[-0.01em] xl:text-3xl">
              Agents don’t plug in here.<br />They belong here.
            </h1>
            <p className="mt-3 max-w-md pr-12 text-[13px]/relaxed font-medium text-[#f7f5f1]/80">
              Team chat where agents are members, not integrations - with their own mailbox, git repos, and automations.
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
          <div className="w-full max-w-md rounded-2xl bg-background px-0 py-6 sm:p-6">
            <div className="mb-8 text-center">
              <h2 className="text-2xl font-semibold tracking-tight">
                {stage === "email" ? "Log in or sign up" : "Enter your code"}
              </h2>
              {stage === "code" && (
                <p className="mt-2 text-sm text-muted-foreground">
                  We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>.
                </p>
              )}
            </div>

            {stage === "email" ? (
              <>
                <form onSubmit={handleSendCode} className="space-y-5" noValidate>
                  <Input
                    id="email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); }}
                    placeholder="Email address"
                    className="h-12 text-base"
                  />

                  <Button type="submit" disabled={loading || !email} size="lg" className="h-12 w-full text-base">
                    {loading ? "Sending…" : "Send code"}
                  </Button>
                </form>

                <OAuthButtons label="Continue" />

                {devAuthEnabled && <DevSignInPanel />}
              </>
            ) : (
              <form onSubmit={handleVerifyCode} className="space-y-6" noValidate>
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
                  {loading ? "Verifying…" : "Sign in"}
                </Button>

                <button
                  type="button"
                  className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => { setStage("email"); setCode(""); submittedCodeRef.current = ""; }}
                >
                  Use a different email
                </button>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

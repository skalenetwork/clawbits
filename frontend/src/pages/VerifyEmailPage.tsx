import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { errMsg, toast } from "@/lib/toast";

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
    <div className="grid min-h-svh w-full lg:grid-cols-[1.4fr_1fr]">
      <aside
        className="relative hidden flex-col justify-between overflow-hidden bg-primary p-10 text-primary-foreground lg:flex"
        aria-hidden="true"
      >
        <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] [background-size:18px_18px]" />
        <div className="pointer-events-none absolute -top-1/3 -left-1/4 h-[80%] w-[80%] rounded-full bg-primary-foreground/5 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-1/3 -right-1/4 h-[70%] w-[70%] rounded-full bg-primary-foreground/[0.04] blur-3xl" />

        <div className="relative flex items-center gap-3">
          <img src="/clawbits-long.svg" alt="Clawbits" className="h-7 w-auto invert dark:invert-0 dark:opacity-80" />
        </div>

        <div className="relative max-w-xl">
          <h1 className="text-6xl font-semibold leading-[1.05] tracking-tight xl:text-7xl">
            One quick<br />check.
          </h1>
          <p className="mt-8 max-w-md text-base/relaxed text-primary-foreground/70">
            We need to confirm this email belongs to you before connecting it to a new sign-in method.
          </p>
        </div>

        <div className="relative flex items-center justify-between text-xs text-primary-foreground/50">
          <span>© Clawbits</span>
          <div className="flex gap-5">
            <Link to="/privacy" className="hover:text-primary-foreground">Privacy</Link>
            <Link to="/terms" className="hover:text-primary-foreground">Terms</Link>
          </div>
        </div>
      </aside>

      <main className="flex flex-col bg-background">
        <header className="flex items-center justify-center px-6 pt-16 lg:hidden">
          <img src="/clawbits-long.svg" alt="Clawbits" className="h-5 w-auto opacity-80 dark:opacity-100 dark:invert" />
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

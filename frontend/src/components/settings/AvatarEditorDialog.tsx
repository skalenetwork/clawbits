import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Cropper, { type Area } from "react-easy-crop";
import {
    Upload04Icon as UploadIcon,
    Camera01Icon as CameraIcon,
    Image01Icon as ImageIcon,
    ZoomInAreaIcon as ZoomInIcon,
    ZoomOutAreaIcon as ZoomOutIcon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/context/AuthContext";
import { uploadOwnAvatar, type AvatarRef, type HumanUser } from "@/lib/api";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const MAX_MB = 5;
// Edge length of the JPEG we upload after the client-side crop. 1024px
// is 2× the largest render site (88px profile header @2x retina = 176px,
// plus headroom for future @3x or hero treatments) and keeps the upload
// well under 200KB at quality 92 — well below the 5MB endpoint cap.
const EXPORT_SIZE = 1024;
const EXPORT_QUALITY = 0.92;

interface AvatarEditorDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Current user — used for the "before" preview + initial-letter
     *  fallback. After upload completes, the parent typically refetches
     *  /api/auth/me so this prop updates on its own. */
    user: HumanUser;
}

/** Validate locally before we waste a network round-trip on a file that
 *  the backend would reject anyway. Mirrors the server's checks. */
function validateLocally(file: File): string | null {
    if (!ACCEPT.split(",").includes(file.type)) {
        return "Use a PNG, JPEG, WebP, or GIF.";
    }
    if (file.size > MAX_MB * 1024 * 1024) {
        return `File is too big — max ${String(MAX_MB)} MB.`;
    }
    return null;
}

/** Bake the user's crop + zoom into a square JPEG ``Blob``.
 *
 *  ``croppedAreaPixels`` comes from react-easy-crop's ``onCropComplete``
 *  callback in source-image pixel coordinates, so we can ``drawImage``
 *  directly from those numbers without re-deriving from the zoom/crop
 *  state. Uses ``createImageBitmap`` for decode — it offloads to a
 *  worker thread on every modern browser (Chrome 50+, Safari 15+,
 *  Firefox 90+) so a multi-megapixel decode doesn't jank the main
 *  thread. */
async function bakeCrop(file: File, area: Area): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = EXPORT_SIZE;
        canvas.height = EXPORT_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");
        // Smooth high-quality downscale — matters because the source
        // may be 4000×4000 and we're outputting 1024×1024.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
            bitmap,
            area.x, area.y, area.width, area.height,   // source rect
            0, 0, EXPORT_SIZE, EXPORT_SIZE,             // dest rect
        );
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                blob => { blob ? resolve(blob) : reject(new Error("toBlob returned null")); },
                "image/jpeg",
                EXPORT_QUALITY,
            );
        });
    } finally {
        bitmap.close();
    }
}

export function AvatarEditorDialog({ open, onOpenChange, user }: AvatarEditorDialogProps) {
    const { applyProfileUpdate } = useAuth();
    const [file, setFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    // Latest ``croppedAreaPixels`` reported by the Cropper — used by the
    // Save handler to bake the export. Held in a ref so we don't
    // re-render on every drag.
    const croppedAreaRef = useRef<Area | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Build / tear down an object URL for the local preview. Without
    // revoke we'd leak the URL on every file change.
    useEffect(() => {
        if (!file) {
            setPreviewUrl(null);
            return;
        }
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        return () => { URL.revokeObjectURL(url); };
    }, [file]);

    // Reset transient state every time the dialog re-opens so the
    // previous attempt's preview doesn't leak into the new session.
    useEffect(() => {
        if (!open) {
            setFile(null);
            setIsDragging(false);
            setCrop({ x: 0, y: 0 });
            setZoom(1);
            croppedAreaRef.current = null;
        }
    }, [open]);

    const uploadMutation = useMutation({
        mutationFn: async (blob: Blob): Promise<AvatarRef> => uploadOwnAvatar(blob),
        onSuccess: (avatar) => {
            // Merge the new avatar into the cached user so the hero
            // card refreshes without waiting on a /me refetch.
            applyProfileUpdate({ ...user, avatar });
            toast.success("Profile picture updated");
            onOpenChange(false);
        },
        onError: (err) => {
            toast.error(errMsg(err, "Couldn't update profile picture"));
        },
    });

    const acceptFile = useCallback((next: File) => {
        const err = validateLocally(next);
        if (err) {
            toast.error(err);
            return;
        }
        setFile(next);
        // Reset crop transform whenever a fresh file enters — without
        // this, a previous image's zoom would carry over.
        setCrop({ x: 0, y: 0 });
        setZoom(1);
        croppedAreaRef.current = null;
    }, []);

    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) acceptFile(dropped);
    }, [acceptFile]);

    const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
        croppedAreaRef.current = areaPixels;
    }, []);

    const handleSave = async () => {
        if (!file) return;
        const area = croppedAreaRef.current;
        if (!area) {
            // Defensive — onCropComplete fires synchronously after the
            // Cropper mounts, so this would only happen if the user
            // managed to click Save before the layout pass.
            toast.error("Couldn't read crop — try again");
            return;
        }
        try {
            const blob = await bakeCrop(file, area);
            uploadMutation.mutate(blob);
        } catch (err) {
            toast.error(errMsg(err, "Couldn't process image"));
        }
    };

    const busy = uploadMutation.isPending;
    const fallbackName = user.display_name ?? user.email;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={CameraIcon} className="text-muted-foreground" />
                        Change profile picture
                    </DialogTitle>
                    <DialogDescription>
                        {file
                            ? "Drag to reposition, pinch or scroll to zoom."
                            : "Upload an image — you can crop and zoom before saving."}
                    </DialogDescription>
                </DialogHeader>

                {file && previewUrl ? (
                    <CropperPanel
                        imageUrl={previewUrl}
                        crop={crop}
                        zoom={zoom}
                        onCropChange={setCrop}
                        onZoomChange={setZoom}
                        onCropComplete={onCropComplete}
                        onPickAnother={() => { fileInputRef.current?.click(); }}
                        busy={busy}
                    />
                ) : (
                    <DropZone
                        fallbackUserName={fallbackName}
                        fallbackUserAvatar={user.avatar?.url}
                        isDragging={isDragging}
                        setIsDragging={setIsDragging}
                        onDrop={handleDrop}
                        onPick={() => { fileInputRef.current?.click(); }}
                    />
                )}

                <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPT}
                    className="hidden"
                    onChange={(e) => {
                        const picked = e.target.files?.[0];
                        if (picked) acceptFile(picked);
                        // Reset so picking the same file twice still
                        // fires onChange the second time.
                        e.target.value = "";
                    }}
                />

                <DialogFooter>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => { onOpenChange(false); }}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={() => { void handleSave(); }}
                        disabled={!file || busy}
                    >
                        {busy ? "Uploading…" : "Save"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Sub-components — split so the file is easier to scan, and so the
// Cropper-bearing branch doesn't re-mount each time the user types.
// ---------------------------------------------------------------------------

function DropZone({
    fallbackUserName,
    fallbackUserAvatar,
    isDragging,
    setIsDragging,
    onDrop,
    onPick,
}: {
    fallbackUserName: string;
    fallbackUserAvatar?: string | null;
    isDragging: boolean;
    setIsDragging: (v: boolean) => void;
    onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
    onPick: () => void;
}) {
    return (
        <>
            <div className="flex items-center justify-center py-2">
                <img
                    src={fallbackUserAvatar ?? undefined}
                    alt={fallbackUserName}
                    className={cn(
                        "size-32 rounded-2xl object-cover ring-1 ring-border/60",
                        !fallbackUserAvatar && "bg-muted",
                    )}
                    draggable={false}
                />
            </div>
            <div
                role="button"
                tabIndex={0}
                onClick={onPick}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPick();
                    }
                }}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => { setIsDragging(false); }}
                onDrop={onDrop}
                className={cn(
                    "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-6 text-center transition-colors",
                    "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                    isDragging
                        ? "border-primary bg-primary/5"
                        : "border-border/60 hover:border-border hover:bg-muted/40",
                )}
            >
                <Icon icon={UploadIcon} className="size-6 text-muted-foreground"/>
                <div className="space-y-0.5">
                    <p className="text-sm font-medium text-foreground">
                        Drop an image here, or click to browse
                    </p>
                    <p className="text-xs text-muted-foreground">
                        PNG · JPEG · WebP · GIF · max {String(MAX_MB)} MB
                    </p>
                </div>
            </div>
        </>
    );
}

function CropperPanel({
    imageUrl,
    crop,
    zoom,
    onCropChange,
    onZoomChange,
    onCropComplete,
    onPickAnother,
    busy,
}: {
    imageUrl: string;
    crop: { x: number; y: number };
    zoom: number;
    onCropChange: (next: { x: number; y: number }) => void;
    onZoomChange: (next: number) => void;
    onCropComplete: (area: Area, pixels: Area) => void;
    onPickAnother: () => void;
    busy: boolean;
}) {
    return (
        <div className="space-y-3">
            {/* Fixed-height cropping viewport. react-easy-crop measures
                its parent so we MUST give the container an explicit size
                — without ``relative`` + height it renders 0×0 and silently
                shows nothing. */}
            <div className="relative h-64 overflow-hidden rounded-xl bg-black/90">
                <Cropper
                    image={imageUrl}
                    crop={crop}
                    zoom={zoom}
                    aspect={1}
                    cropShape="rect"
                    showGrid={false}
                    minZoom={1}
                    maxZoom={4}
                    zoomSpeed={0.4}
                    restrictPosition
                    objectFit="contain"
                    onCropChange={onCropChange}
                    onZoomChange={onZoomChange}
                    onCropComplete={onCropComplete}
                    // Rounded-corner square mask matches the actual
                    // avatar render (``rounded-lg`` on Avatar.tsx) so
                    // what the user crops is what they'll see.
                    style={{
                        cropAreaStyle: {
                            borderRadius: 14,
                            border: "2px solid rgba(255,255,255,0.92)",
                            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                        },
                    }}
                />
            </div>

            {/* Zoom slider — native range input so we don't pull in
                another component lib. Tailwind handles the look. */}
            <div className="flex items-center gap-3 px-1">
                <Icon icon={ZoomOutIcon} className="size-4 shrink-0 text-muted-foreground"/>
                <input
                    type="range"
                    aria-label="Zoom"
                    min={1}
                    max={4}
                    step={0.01}
                    value={zoom}
                    onChange={(e) => { onZoomChange(Number(e.target.value)); }}
                    disabled={busy}
                    className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
                <Icon icon={ZoomInIcon} className="size-4 shrink-0 text-muted-foreground"/>
            </div>

            <button
                type="button"
                onClick={onPickAnother}
                disabled={busy}
                className={cn(
                    "inline-flex items-center gap-1.5 text-xs font-medium",
                    "text-muted-foreground hover:text-foreground",
                    "focus-visible:outline-none focus-visible:underline",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                )}
            >
                <Icon icon={ImageIcon} className="size-3.5"/>
                Choose a different image
            </button>
        </div>
    );
}

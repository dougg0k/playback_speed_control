export function clampSpeed(value: number): number {
	if (Number.isNaN(value) || !Number.isFinite(value)) return 1;
	return Math.min(16, Math.max(0.07, Number(value.toFixed(2))));
}

export function roundSpeed(value: number): number {
	return Number(clampSpeed(value).toFixed(2));
}

export function formatSpeed(value: number | null | undefined): string {
	if (typeof value !== "number" || Number.isNaN(value)) return "—";
	const rounded = roundSpeed(value);
	const text = Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
	return `${text}x`;
}

export function formatBadgeSpeed(value: number | null | undefined): string {
	if (typeof value !== "number" || Number.isNaN(value)) return "";
	const rounded = roundSpeed(value);
	const withSuffix = Number.isInteger(rounded) ? `${rounded}x` : `${rounded}`;
	return withSuffix.slice(0, 4);
}

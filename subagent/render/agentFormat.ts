export function statusIcon(status: string): string {
	switch (status) {
		case "queued": return "…";
		case "running": return "⏳";
		case "succeeded": return "✓";
		case "failed": return "✗";
		case "interrupted": return "⚠";
		case "lost": return "?";
		case "closed": return "■";
		default: return "•";
	}
}

export function statusColor(status: string): string {
	switch (status) {
		case "running": return "warning";
		case "queued": return "muted";
		case "succeeded": return "success";
		case "failed": return "error";
		case "interrupted":
		case "lost": return "warning";
		case "closed": return "muted";
		default: return "accent";
	}
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest ? `${rest}s` : ""}`;
}

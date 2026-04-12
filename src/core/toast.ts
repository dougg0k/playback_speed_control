const TOAST_ID = "psc-toast";
const TOAST_STYLE_ID = "psc-toast-style";

function getStyleParent(): HTMLElement {
	return document.head ?? document.documentElement;
}

function getToastParent(): HTMLElement {
	return document.body ?? document.documentElement;
}

function ensureStyles(): void {
	if (document.getElementById(TOAST_STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = TOAST_STYLE_ID;
	style.textContent = `
    #${TOAST_ID} {
      position: fixed;
      left: 18px;
      top: 18px;
      z-index: 2147483646;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(17, 24, 39, 0.42);
      color: rgba(255, 255, 255, 0.88);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      font: 500 12px/1.2 Inter, system-ui, sans-serif;
      letter-spacing: 0.01em;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 140ms ease, transform 140ms ease;
      pointer-events: none;
      user-select: none;
      max-width: min(240px, calc(100vw - 36px));
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${TOAST_ID}[data-visible="true"] {
      opacity: 1;
      transform: translateY(0);
    }
  `;

	getStyleParent().appendChild(style);
}

export class ToastController {
	private element: HTMLDivElement | null = null;
	private timeoutId: number | null = null;

	show(message: string): void {
		ensureStyles();

		if (!this.element || !this.element.isConnected) {
			this.element = document.createElement("div");
			this.element.id = TOAST_ID;
			getToastParent().appendChild(this.element);
		}

		this.element.textContent = message;
		this.element.dataset.visible = "true";

		if (this.timeoutId !== null) {
			window.clearTimeout(this.timeoutId);
		}

		this.timeoutId = window.setTimeout(() => {
			if (this.element) {
				this.element.dataset.visible = "false";
			}
		}, 1100);
	}
}

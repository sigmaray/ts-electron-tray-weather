declare module "canvas" {
  export function createCanvas(width: number, height: number): HTMLCanvasElement;
  
  interface HTMLCanvasElement {
    getContext(contextId: "2d"): CanvasRenderingContext2D;
    toBuffer(mimeType?: string): Buffer;
  }
  
  interface CanvasRenderingContext2D {
    fillStyle: string;
    strokeStyle: string;
    font: string;
    textAlign: string;
    textBaseline: string;
    lineWidth: number;
    fillRect(x: number, y: number, width: number, height: number): void;
    fillText(text: string, x: number, y: number): void;
    strokeText(text: string, x: number, y: number): void;
    beginPath(): void;
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
    fill(): void;
    closePath(): void;
  }
}


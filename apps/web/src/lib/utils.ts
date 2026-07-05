import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class combinator: conditional classes + Tailwind conflict merge. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { redirect } from 'next/navigation';

/** The inbox IS the dashboard's home — Phase 3 (frontend priority #1). */
export default function Home() {
  redirect('/inbox');
}

import type { Metadata } from 'next';
import { LabWorkspace } from '@/components/lab/LabWorkspace';

export const metadata: Metadata = {
  title: 'Lab',
  description: 'Build a quantum circuit by hand or in code, and watch the state change as you type.',
};

export default function LabPage() {
  return <LabWorkspace />;
}

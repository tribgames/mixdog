// The capability request rules as the desktop's host applies them: ipc-validation.ts's, with this machine's own check of whether a
// path is absolute. Main process only (`node:path`); the phone's page passes its own predicate to the same rules.
import { isAbsolute } from 'node:path';
import type { DesktopCapabilityReadRequest, DesktopCapabilityRequest } from '../shared/contract';
import { requiredCapabilityReadRequestsUsing, requiredCapabilityRequestUsing } from './ipc-validation';

export const requiredDesktopCapabilityRequest = (value: unknown): DesktopCapabilityRequest => requiredCapabilityRequestUsing(value, isAbsolute);

export const requiredDesktopCapabilityReadRequests = (value: unknown): DesktopCapabilityReadRequest[] =>
  requiredCapabilityReadRequestsUsing(value, isAbsolute);

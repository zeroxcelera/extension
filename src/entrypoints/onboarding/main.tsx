import { render } from 'preact';
import { Onboarding } from './Onboarding';

const root = document.getElementById('app');
if (root) render(<Onboarding />, root);

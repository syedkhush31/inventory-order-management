// The Add / Edit customer form with a fake fetch: no backend or database is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CustomerForm from './CustomerForm.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const CUSTOMER = {
  id: 9,
  name: 'Ann Lee',
  email: 'ann@example.com',
  phone: '555 0100',
  address: '1 Main St',
  isActive: true,
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:00:00.000Z',
};

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const name = () => screen.getByLabelText(/^Name/);
const email = () => screen.getByLabelText(/^Email/);
const phone = () => screen.getByLabelText(/^Phone/);
const address = () => screen.getByLabelText(/^Address/);
const submit = (label) => screen.getByRole('button', { name: label });

function setup(props = {}) {
  const handlers = { onCreated: vi.fn(), onSaved: vi.fn(), onCancel: vi.fn() };
  render(<CustomerForm {...handlers} {...props} />);
  return handlers;
}

function fill({ n = 'Ann Lee', e = 'ann@example.com', p = '', a = '' } = {}) {
  fireEvent.change(name(), { target: { value: n } });
  fireEvent.change(email(), { target: { value: e } });
  fireEvent.change(phone(), { target: { value: p } });
  fireEvent.change(address(), { target: { value: a } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('add mode', () => {
  test('is titled Add customer, empty, focused on the name, with required marks', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Add customer' })).toBeInTheDocument();
    expect(name()).toHaveValue('');
    expect(name()).toHaveFocus();
    expect(name()).toHaveAttribute('aria-required', 'true');
    expect(email()).toHaveAttribute('aria-required', 'true');
    expect(phone()).not.toHaveAttribute('aria-required');
    expect(address()).not.toHaveAttribute('aria-required');
  });

  test('empty required fields are reported without sending, and focus goes to the first problem', () => {
    setup();
    fireEvent.click(submit('Add customer'));
    expect(screen.getByText('Enter the customer name.')).toBeInTheDocument();
    expect(screen.getByText('Enter an email address.')).toBeInTheDocument();
    expect(name()).toHaveFocus();
    expect(name()).toHaveAttribute('aria-invalid', 'true');
    expect(name()).toHaveAccessibleDescription(/Enter the customer name\./);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['a bad email', { e: 'nope' }, 'Enter a valid email address, such as name@example.com.'],
    ['a bad phone', { p: 'abc' }, /Use digits and/],
    ['a long address', { a: 'a'.repeat(501) }, 'Address must be 500 characters or fewer.'],
  ])('%s is caught without sending', (_label, values, message) => {
    setup();
    fill(values);
    fireEvent.click(submit('Add customer'));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an error disappears when the user edits that field', () => {
    setup();
    fireEvent.click(submit('Add customer'));
    fireEvent.change(name(), { target: { value: 'A' } });
    expect(screen.queryByText('Enter the customer name.')).not.toBeInTheDocument();
    expect(screen.getByText('Enter an email address.')).toBeInTheDocument();
  });

  test('POSTs the cleaned values with cookies and reports the saved customer', async () => {
    fetch.mockImplementation(async () => reply({ customer: CUSTOMER }, 201));
    const { onCreated } = setup();
    fill({ n: '  Ann Lee ', e: ' ANN@Example.com ', p: '  ', a: ' 1 Main St ' });
    fireEvent.click(submit('Add customer'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CUSTOMER));
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/customers');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ name: 'Ann Lee', email: 'ann@example.com', phone: null, address: '1 Main St' });
  });

  test('a second submit while saving does not send a second request', async () => {
    let finish;
    fetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    setup();
    fill();
    const form = submit('Add customer').closest('form');
    fireEvent.click(submit('Add customer'));
    fireEvent.submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    finish(reply({ customer: CUSTOMER }, 201));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  test('Cancel calls onCancel and sends nothing', () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('edit mode', () => {
  test('is titled Edit customer and pre-filled; a null phone and address show as empty', () => {
    setup({ customer: { ...CUSTOMER, phone: null, address: null } });
    expect(screen.getByRole('heading', { name: 'Edit customer' })).toBeInTheDocument();
    expect(name()).toHaveValue('Ann Lee');
    expect(email()).toHaveValue('ann@example.com');
    expect(phone()).toHaveValue('');
    expect(address()).toHaveValue('');
  });

  test('PATCHes only the fields that changed and reports the saved customer', async () => {
    const saved = { ...CUSTOMER, name: 'Ann Smith' };
    fetch.mockImplementation(async () => reply({ customer: saved }));
    const { onSaved } = setup({ customer: CUSTOMER });
    fireEvent.change(name(), { target: { value: ' Ann Smith ' } });
    fireEvent.click(submit('Save changes'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/customers/9');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ name: 'Ann Smith' });
  });

  test('clearing the phone sends null so the server removes it', async () => {
    fetch.mockImplementation(async () => reply({ customer: { ...CUSTOMER, phone: null } }));
    const { onSaved } = setup({ customer: CUSTOMER });
    fireEvent.change(phone(), { target: { value: '' } });
    fireEvent.click(submit('Save changes'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ phone: null });
  });

  test('saving without any change sends nothing and says so', () => {
    const { onSaved } = setup({ customer: CUSTOMER });
    fireEvent.click(submit('Save changes'));
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing has been changed yet');
    expect(fetch).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test('uses the same rules as the add form', () => {
    setup({ customer: CUSTOMER });
    fireEvent.change(email(), { target: { value: 'nope' } });
    fireEvent.click(submit('Save changes'));
    expect(screen.getByText('Enter a valid email address, such as name@example.com.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('server failures', () => {
  test('a duplicate email (409) is shown on the email field and nothing is reported as saved', async () => {
    fetch.mockImplementation(async () => reply({ error: 'dup', fields: ['email'] }, 409));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit('Add customer'));

    expect(await screen.findByText(/A customer with this email already exists/)).toBeInTheDocument();
    expect(email()).toHaveFocus();
    expect(onCreated).not.toHaveBeenCalled();
    expect(submit('Add customer')).toBeEnabled();
  });

  test('a 400 marks the fields the server named', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['phone'] }, 400));
    setup();
    fill({ p: '555 0100' });
    fireEvent.click(submit('Add customer'));
    expect(await screen.findByText('The server did not accept this value. Please check it.')).toBeInTheDocument();
    expect(phone()).toHaveFocus();
  });

  test('a 404 while editing says the customer no longer exists', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Customer not found' }, 404));
    const { onSaved } = setup({ customer: CUSTOMER });
    fireEvent.change(name(), { target: { value: 'x' } });
    fireEvent.click(submit('Save changes'));
    expect(await screen.findByRole('alert')).toHaveTextContent('This customer no longer exists');
    expect(onSaved).not.toHaveBeenCalled();
  });

  test('a network failure warns the customer may not have been saved', async () => {
    fetch.mockImplementation(async () => {
      throw new TypeError('failed');
    });
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit('Add customer'));
    expect(await screen.findByRole('alert')).toHaveTextContent('may not have been saved');
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('a reply without a customer is not treated as saved', async () => {
    fetch.mockImplementation(async () => reply({}, 201));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit('Add customer'));
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been saved');
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('a 500 shows a generic message', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Internal server error' }, 500));
    setup();
    fill();
    fireEvent.click(submit('Add customer'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong and the customer was not saved');
  });
});

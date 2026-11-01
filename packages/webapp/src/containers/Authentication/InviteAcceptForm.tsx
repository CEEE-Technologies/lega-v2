import { Intent } from '@blueprintjs/core';
import { Formik, FormikHelpers } from 'formik';
import { isEmpty } from 'lodash';
import intl from 'react-intl-universal';
import { useHistory } from 'react-router-dom';
import { AuthInsiderCard } from './_components';
import { InviteUserFormContent as InviteAcceptFormContent } from './InviteAcceptFormContent';
import { useInviteAcceptContext } from './InviteAcceptProvider';
import { InviteAcceptSchema, InviteAcceptFormValues } from './utils';
import type { ApiError } from 'openapi-typescript-fetch';
import { AppToaster } from '@/components';

const initialValues: InviteAcceptFormValues = {
  organizationName: '',
  invitedEmail: '',
  firstName: '',
  lastName: '',
  password: '',
};

export function InviteAcceptForm() {
  const history = useHistory();

  // Invite accept context.
  const { inviteAcceptMutate, inviteMeta, token } = useInviteAcceptContext();

  // Invite value.
  const inviteFormValue: InviteAcceptFormValues = {
    ...initialValues,
    ...(!isEmpty(inviteMeta)
      ? {
          invitedEmail: inviteMeta?.email ?? '',
          organizationName: inviteMeta?.organizationName ?? '',
        }
      : {}),
  };

  // Handle form submitting.
  const handleSubmit = (
    values: InviteAcceptFormValues,
    { setSubmitting }: FormikHelpers<InviteAcceptFormValues>,
  ) => {
    inviteAcceptMutate([
      {
        firstName: values.firstName,
        lastName: values.lastName,
        password: values.password,
      },
      token,
    ])
      .then(() => {
        AppToaster.show({
          message: intl.getHTML(
            'congrats_your_account_has_been_created_and_invited',
            {
              organization_name: inviteMeta?.organizationName ?? '',
            },
          ),
          intent: Intent.SUCCESS,
        });
        history.push('/auth/login');
      })
      .catch((response: ApiError) => {
        const errors =
          (response.data?.errors as
            | Array<{ type?: string; message?: string }>
            | undefined) ?? [];

        // The email already has a login: its current password is needed.
        const passwordMismatch = errors.find(
          (e) => e.type === 'EXISTING_LOGIN_PASSWORD_MISMATCH',
        );
        if (passwordMismatch) {
          AppToaster.show({
            message: passwordMismatch.message,
            intent: Intent.DANGER,
          });
        }

        if (errors.find((e) => e.type === 'INVITE_TOKEN_INVALID')) {
          AppToaster.show({
            message: intl.get('an_unexpected_error_occurred'),
            intent: Intent.DANGER,
          });
          history.push('/auth/login');
        }
        setSubmitting(false);
      });
  };

  return (
    <AuthInsiderCard>
      <Formik
        validationSchema={InviteAcceptSchema}
        initialValues={inviteFormValue}
        onSubmit={handleSubmit}
        component={InviteAcceptFormContent}
      />
    </AuthInsiderCard>
  );
}

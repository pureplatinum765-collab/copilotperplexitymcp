import imaplib
import smtplib
import email
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# --- Configuration ---
# You will need to fill these in with your actual email provider's details.
# For security, it's best to use an "App Password" instead of your main password.
IMAP_SERVER = "imap.example.com"  # e.g., "imap.gmail.com" for Gmail
SMTP_SERVER = "smtp.example.com"  # e.g., "smtp.gmail.com" for Gmail
EMAIL_ADDRESS = "your_email@example.com"
EMAIL_PASSWORD = "your_app_password"

def connect_and_fetch_emails():
    """
    Connects to the email server and fetches unseen emails.
    """
    try:
        # Connect to the IMAP server to read emails
        mail = imaplib.IMAP4_SSL(IMAP_SERVER)
        mail.login(EMAIL_ADDRESS, EMAIL_PASSWORD)
        
        # Select the inbox to look for emails
        mail.select("inbox")
        
        # Search for all unseen emails
        status, messages = mail.search(None, "UNSEEN")
        
        if status != "OK":
            print("No new emails to process.")
            return []
            
        email_ids = messages[0].split()
        fetched_emails = []
        
        # Fetch each email's content
        for email_id in email_ids:
            _, msg_data = mail.fetch(email_id, "(RFC822)")
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    fetched_emails.append(msg)
                    
        mail.logout()
        return fetched_emails
        
    except Exception as e:
        print(f"An error occurred while fetching emails: {e}")
        return []

def send_email(to_address, subject, body):
    """
    Sends an email using the SMTP server.
    """
    try:
        # Set up the email message
        message = MIMEMultipart()
        message["From"] = EMAIL_ADDRESS
        message["To"] = to_address
        message["Subject"] = subject
        message.attach(MIMEText(body, "plain"))
        
        # Connect to the SMTP server to send the email
        with smtplib.SMTP_SSL(SMTP_SERVER, 465) as server:
            server.login(EMAIL_ADDRESS, EMAIL_PASSWORD)
            server.sendmail(EMAIL_ADDRESS, to_address, message.as_string())
            print("Email sent successfully!")
            
    except Exception as e:
        print(f"An error occurred while sending the email: {e}")

# This is an example of how you might use these functions.
# We will build on this in the main application script.
if __name__ == "__main__":
    print("Checking for new emails...")
    new_emails = connect_and_fetch_emails()
    
    if new_emails:
        print(f"Found {len(new_emails)} new email(s).")
        # In the future, we will process these emails and generate replies.
    else:
        print("No new emails found.")
        
    # Example of sending an email (currently disabled)
    # send_email("recipient@example.com", "Test Subject", "This is a test email from the Business Assistant.")

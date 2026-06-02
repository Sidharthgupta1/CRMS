class Atm: 
    def __init__(self):
        self.pin= ''
        self.balance= 0
        self.menu()
        
    def menu(self):
            user_input= input("""
            Hello, how would you like to proceed?
            [1] Check Balance
            [2] Withdraw
            [3] Deposit
            [4] Exit
            """)
            
            if user_input== '1':
                self.check_balance()
            elif user_input== '2':
                self.withdraw()
            elif user_input== '3':
                self.deposit()
            elif user_input== '4':
                print("Thank you for using our ATM. Goodbye!")
                exit()
            else:
                print("Invalid input. Please try again.")
                self.menu()
                
    def check_balance(self):
            print(f"Your balance is: ${self.balance}")
            self.menu() 

    def withdraw(self):
            amount= int(input("Enter the amount you want to withdraw: "))
            if amount> self.balance:
                print("Insufficient balance. Please try again.")
                self.withdraw()
            else:
                self.balance-= amount
                print(f"${amount} withdrawn successfully. Your new balance is: ${self.balance}")
                self.menu()
                
    def deposit(self):
            amount= int(input("Enter the amount you want to deposit: "))
            self.balance+= amount
            print(f"${amount} deposited successfully. Your new balance is: ${self.balance}")
            self.menu()
            
    def exit(self):
            print("Thank you for using our ATM. Goodbye!")
            exit()
            
    def invalid_input(self):
            print("Invalid input. Please try again.")
            self.menu()

object= Atm()